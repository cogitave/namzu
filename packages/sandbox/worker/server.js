/**
 * @namzu/sandbox container-backend worker.
 *
 * Lives inside the per-task Docker container; talks HTTP on
 * loopback to the host-side `DockerSandboxBackend` adapter. The
 * host spawns one container per `Sandbox` instance and tears it
 * down on `destroy()`.
 *
 * Why HTTP and not stdin/stdout: a long-running container with a
 * stable HTTP surface lets the host issue many `exec` /
 * `read-file` / `write-file` calls per task without spawning a
 * new container for each (cold-start kills latency). Compass-
 * platform's worker uses the same shape; namzu's protocol is
 * deliberately a simplified subset because the namzu backend is
 * trusted-tenant by default. (For adversarial multi-tenant the
 * host picks the `microvm` tier instead.)
 *
 * Endpoints:
 *   GET  /healthz       — liveness probe.
 *   POST /execute       — run a command inside the workspace.
 *                         body: { command, args, cwd, env, stdin,
 *                                 timeoutMs, maxOutputBytes }
 *                         response: NDJSON stream of
 *                                 { type: 'stdout_delta'|'stderr_delta'
 *                                       |'result'|'error', ... }
 *   POST /read-file     — read a file from the workspace.
 *                         body: { path, encoding? }
 *                         response: { ok, content, sizeBytes }
 *   POST /write-file    — write a file inside the workspace.
 *                         body: { path, content, encoding? }
 *                         response: { ok, bytesWritten }
 *
 * Authn: none. The container only listens on loopback inside its
 * own network namespace; the only thing that can talk to it is
 * the host adapter via Docker's port-forward. JWT-style auth is
 * the egress proxy's job (separate concern, P3.2).
 */

const http = require('node:http')
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')

const PORT = Number(process.env.NAMZU_SANDBOX_PORT || 2024)
const WORKSPACE_ROOT = process.env.NAMZU_SANDBOX_WORKSPACE || '/workspace'
const MAX_BODY_BYTES = Number(process.env.NAMZU_SANDBOX_MAX_BODY_BYTES || 8 * 1024 * 1024)
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let total = 0
		req.on('data', (chunk) => {
			total += chunk.length
			if (total > MAX_BODY_BYTES) {
				reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
			} catch (err) {
				reject(err)
			}
		})
		req.on('error', reject)
	})
}

function writeJson(res, status, payload) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
	res.end(JSON.stringify(payload))
}

function writeEvent(res, event) {
	res.write(`${JSON.stringify(event)}\n`)
}

function resolveWithinWorkspace(p, base) {
	const resolved = path.resolve(base, p)
	const baseResolved = path.resolve(base)
	if (!resolved.startsWith(`${baseResolved}${path.sep}`) && resolved !== baseResolved) {
		throw new Error('path escapes the workspace')
	}
	return resolved
}

/**
 * After lexical resolution proves the requested path doesn't ESCAPE
 * `/workspace` via `..`, we still have to defend against symlinks
 * inside the workspace pointing OUTSIDE it (e.g. `/workspace/leak ->
 * /etc/passwd`). The lexical check only inspects the string; the
 * actual `fs.readFile` follows symlinks. Resolve via `realpath` and
 * verify the resolved target is still inside the workspace before
 * touching the file.
 *
 * For writes the parent directory's realpath is what matters — the
 * file itself may not exist yet, so realpath the parent and
 * reconstruct the final path. If the parent contains a symlink
 * jumping out of the workspace, this rejects the write.
 */
async function realpathWithinWorkspace(target, base) {
	const baseReal = await fs.realpath(path.resolve(base))
	let real
	try {
		real = await fs.realpath(target)
	} catch (err) {
		if (err && err.code === 'ENOENT') {
			const parentReal = await fs.realpath(path.dirname(target))
			real = path.join(parentReal, path.basename(target))
		} else {
			throw err
		}
	}
	if (!real.startsWith(`${baseReal}${path.sep}`) && real !== baseReal) {
		throw new Error('symlink escapes the workspace')
	}
	return real
}

async function handleExecute(req, res) {
	let body
	try {
		body = await readBody(req)
	} catch (err) {
		writeJson(res, 400, { error: 'invalid_body', message: err.message })
		return
	}

	if (!body.command || typeof body.command !== 'string') {
		writeJson(res, 400, { error: 'missing_command' })
		return
	}

	const cwd = body.cwd ? resolveWithinWorkspace(body.cwd, WORKSPACE_ROOT) : WORKSPACE_ROOT
	const timeoutMs = Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS
	const maxOutputBytes = Number(body.maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES
	const start = Date.now()

	await fs.mkdir(cwd, { recursive: true })

	res.writeHead(200, {
		'content-type': 'application/x-ndjson; charset=utf-8',
		'cache-control': 'no-store',
	})

	const child = spawn(body.command, Array.isArray(body.args) ? body.args : [], {
		cwd,
		env: { ...process.env, ...(body.env || {}) },
		stdio: [body.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
	})

	if (body.stdin !== undefined && child.stdin) {
		child.stdin.end(String(body.stdin))
	}

	const stdout = { chunks: [], bytes: 0, truncated: false }
	const stderr = { chunks: [], bytes: 0, truncated: false }
	let timedOut = false
	let settled = false

	function appendChunk(target, chunk) {
		if (target.truncated) return null
		const remaining = maxOutputBytes - target.bytes
		if (remaining <= 0) {
			target.truncated = true
			return null
		}
		const clipped = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
		target.chunks.push(clipped)
		target.bytes += clipped.length
		if (clipped.length < chunk.length) target.truncated = true
		return clipped
	}

	child.stdout.on('data', (chunk) => {
		const clipped = appendChunk(stdout, chunk)
		if (clipped) writeEvent(res, { type: 'stdout_delta', data: clipped.toString('utf8') })
	})
	child.stderr.on('data', (chunk) => {
		const clipped = appendChunk(stderr, chunk)
		if (clipped) writeEvent(res, { type: 'stderr_delta', data: clipped.toString('utf8') })
	})

	const timeout = setTimeout(() => {
		timedOut = true
		try {
			child.kill('SIGTERM')
		} catch {}
		setTimeout(() => {
			if (!settled) {
				try {
					child.kill('SIGKILL')
				} catch {}
			}
		}, 2_000).unref()
	}, timeoutMs)
	timeout.unref()

	child.on('error', (error) => {
		if (settled) return
		settled = true
		clearTimeout(timeout)
		writeEvent(res, { type: 'error', error: error.message })
		res.end()
	})

	child.on('close', (exitCode) => {
		if (settled) return
		settled = true
		clearTimeout(timeout)
		writeEvent(res, {
			type: 'result',
			exitCode: typeof exitCode === 'number' ? exitCode : -1,
			timedOut,
			durationMs: Date.now() - start,
			stdoutTruncated: stdout.truncated,
			stderrTruncated: stderr.truncated,
		})
		res.end()
	})
}

async function handleReadFile(req, res) {
	let body
	try {
		body = await readBody(req)
	} catch (err) {
		writeJson(res, 400, { error: 'invalid_body', message: err.message })
		return
	}
	if (!body.path) {
		writeJson(res, 400, { error: 'missing_path' })
		return
	}
	try {
		const target = resolveWithinWorkspace(body.path, WORKSPACE_ROOT)
		const real = await realpathWithinWorkspace(target, WORKSPACE_ROOT)
		const buf = await fs.readFile(real)
		const encoding = body.encoding === 'base64' ? 'base64' : 'utf8'
		writeJson(res, 200, {
			ok: true,
			content: buf.toString(encoding),
			sizeBytes: buf.length,
			encoding,
		})
	} catch (err) {
		writeJson(res, 400, { ok: false, error: err.message })
	}
}

async function handleWriteFile(req, res) {
	let body
	try {
		body = await readBody(req)
	} catch (err) {
		writeJson(res, 400, { error: 'invalid_body', message: err.message })
		return
	}
	if (!body.path || body.content === undefined) {
		writeJson(res, 400, { error: 'missing_path_or_content' })
		return
	}
	try {
		const target = resolveWithinWorkspace(body.path, WORKSPACE_ROOT)
		await fs.mkdir(path.dirname(target), { recursive: true })
		const real = await realpathWithinWorkspace(target, WORKSPACE_ROOT)
		const buf =
			body.encoding === 'base64'
				? Buffer.from(String(body.content), 'base64')
				: Buffer.from(String(body.content), 'utf8')
		// flag 'wx' rejects existing symlinks pointing out of the workspace
		// only when the target doesn't exist; for existing files we already
		// confirmed via realpath that they resolve inside /workspace, so a
		// plain writeFile is safe.
		await fs.writeFile(real, buf)
		writeJson(res, 200, { ok: true, bytesWritten: buf.length })
	} catch (err) {
		writeJson(res, 400, { ok: false, error: err.message })
	}
}

const server = http.createServer(async (req, res) => {
	if (req.method === 'GET' && req.url === '/healthz') {
		writeJson(res, 200, { ok: true })
		return
	}
	if (req.method === 'POST' && req.url === '/execute') {
		await handleExecute(req, res)
		return
	}
	if (req.method === 'POST' && req.url === '/read-file') {
		await handleReadFile(req, res)
		return
	}
	if (req.method === 'POST' && req.url === '/write-file') {
		await handleWriteFile(req, res)
		return
	}
	writeJson(res, 404, { error: 'not_found' })
})

server.listen(PORT, '127.0.0.1', () => {
	console.log(`[namzu-sandbox-worker] listening on 127.0.0.1:${PORT} workspace=${WORKSPACE_ROOT}`)
})
