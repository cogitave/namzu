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
 * Authn: none, and nothing here checks a caller. What keeps that safe
 * is the network the container is attached to, NOT the bind address —
 * this listens on every interface by default and has to, for the
 * reasons recorded at the `BIND` constant below. So the boundary is the
 * network namespace, and wherever that boundary is absent this endpoint
 * is reachable by whoever can route to it.
 *
 * This paragraph used to say the worker "only listens on loopback".
 * It does not, ten lines from a comment that says so correctly, and a
 * reader who found the true half stopped looking. The claim also
 * promised authentication from the egress proxy, which has none of any
 * kind — that proxy stamps credentials outbound and checks nothing
 * inbound.
 */

const http = require('node:http')
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')

/**
 * Prefix every variable this worker reads its own configuration from.
 *
 * Load-bearing: {@link childEnvironment} strips it, so the prefix is the
 * boundary between "the worker's configuration" and "the environment the
 * sandbox is supposed to run commands in". A new setting that does not use
 * it is handed to untrusted code automatically.
 */
const WORKER_CONFIG_PREFIX = 'NAMZU_SANDBOX_'

const PORT = Number(process.env.NAMZU_SANDBOX_PORT || 2024)
const WORKSPACE_ROOT = process.env.NAMZU_SANDBOX_WORKSPACE || '/workspace'
const READ_ROOTS = normalizeRoots(
	[WORKSPACE_ROOT, ...(process.env.NAMZU_SANDBOX_READ_ROOTS || '').split(path.delimiter)].filter(
		Boolean,
	),
)
// Writable roots: WORKSPACE_ROOT is always writable; NAMZU_SANDBOX_WRITE_ROOTS
// adds extra RW mounts (e.g. `/mnt/user-data/outputs`, `/mnt/user-data/scratch`)
// so the agent's `write`/`append` tools can land in the sibling mounts the
// host chose, not just inside `/workspace`. This must be a strict subset of
// READ_ROOTS or read-only mounts (uploads, skills) would silently become
// writable.
const WRITE_ROOTS = normalizeRoots(
	[WORKSPACE_ROOT, ...(process.env.NAMZU_SANDBOX_WRITE_ROOTS || '').split(path.delimiter)].filter(
		Boolean,
	),
)
const MAX_BODY_BYTES = Number(process.env.NAMZU_SANDBOX_MAX_BODY_BYTES || 8 * 1024 * 1024)
const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
// Ceiling on the caller-supplied `timeoutMs`. `/execute`'s `timeoutMs` sets
// how long the spawned child (and the container resources it holds — CPU,
// memory, the open NDJSON response) stays alive; upstream this value comes
// straight from the `bash` tool's `timeout` argument, a model-chosen number
// with no cap of its own (see `resolveTimeoutMs` in the firecracker guest
// agent, `agent/agent.cjs`, which guards the same unbounded value on that
// transport). Left unbounded here, a single call can pin a container for as
// long as Node's timer will honor (`setTimeout` clamps at ~24.8 days rather
// than firing early), which is a resource-exhaustion vector, not a
// convenience knob. A request above the cap is REFUSED, not quietly
// clamped: silently running under a different deadline than the caller
// asked for is the "accepted and not applied" shape this codebase treats
// as worse than never offering the control — the caller stops looking,
// and a timeout it believes it set is not the one in force.
const MAX_TIMEOUT_MS = Number(process.env.NAMZU_SANDBOX_MAX_TIMEOUT_MS || 30 * 60 * 1000)
// Idle timeout: if the worker sees no `/execute`, `/read-file`, or
// `/write-file` request for this many ms, it `process.exit(0)`s. The
// container is spawned `--rm` so the daemon collects the corpse
// automatically; that's the cheap layer-2 defense against orphaned
// sandboxes when the Vandal-side TTL or the supervisor's `finally`
// block both fail. `0` disables.
//
// Default 5 min: the Cowork supervisor's median tool-call → tool-call
// gap is well under a minute, so 5 min is a comfortable buffer that
// still bounds runaway lifetime to a single-digit-minute scale. Hosts
// that run longer interactive turns (heavy data-prep, slow LLMs)
// override via env.
const IDLE_TIMEOUT_MS = Number(process.env.NAMZU_SANDBOX_IDLE_TIMEOUT_MS ?? 5 * 60 * 1000)

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

function normalizeRoots(roots) {
	const seen = new Set()
	const normalized = []
	for (const root of roots) {
		const trimmed = String(root || '').trim()
		if (!trimmed) continue
		const resolved = path.resolve(trimmed)
		if (seen.has(resolved)) continue
		seen.add(resolved)
		normalized.push(resolved)
	}
	return normalized
}

function isWithinRoot(resolved, root) {
	return resolved === root || resolved.startsWith(`${root}${path.sep}`)
}

function resolveReadablePath(p) {
	return resolveAgainstRoots(p, READ_ROOTS)
}

function resolveWritablePath(p) {
	return resolveAgainstRoots(p, WRITE_ROOTS)
}

function resolveAgainstRoots(p, roots) {
	if (!path.isAbsolute(p)) {
		return {
			target: resolveWithinWorkspace(p, WORKSPACE_ROOT),
			root: path.resolve(WORKSPACE_ROOT),
		}
	}
	const target = path.resolve(p)
	const root = roots.find((candidate) => isWithinRoot(target, candidate))
	if (!root) {
		throw new Error('path escapes the workspace')
	}
	return { target, root }
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

// Mirrors `resolveTimeoutMs` in `agent/agent.cjs` — same bound, same
// refusal, same unbounded upstream input, different transport. Throws so
// the caller learns its request was rejected; the handler turns that into
// a 400 beside `invalid_cwd`.
function resolveTimeoutMs(rawTimeoutMs) {
	const timeoutMs = rawTimeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(rawTimeoutMs)
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`timeoutMs must be a finite number in (0, ${MAX_TIMEOUT_MS}]`)
	}
	return timeoutMs
}

/**
 * The environment a spawned command runs in.
 *
 * This used to be `{ ...process.env, ...body.env }`, which handed the
 * worker's ENTIRE environment to every command the agent runs — by
 * construction, on every call, visible in a bare `env` in any shell
 * transcript. That is a stronger exposure than "untrusted code could read
 * `/proc/self/environ` if it thought to": it is active propagation, and the
 * agent does not have to go looking.
 *
 * What rode along: `NAMZU_SANDBOX_WORKSPACE`, `_READ_ROOTS` and
 * `_WRITE_ROOTS` — the confinement layout itself, handed to the code being
 * confined — plus every other setting below. So the boundary announced its
 * own shape to the thing it was drawn around.
 *
 * Stripping by prefix rather than by an allowlist of known-safe names is
 * deliberate, and it is the difference between this working and this
 * breaking egress:
 *
 *  - `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` are set on the container ON
 *    PURPOSE, so that tooling inside routes through the egress boundary. An
 *    allowlist assembled from first principles drops them and every
 *    proxied workload silently stops being proxied — which would look
 *    exactly like the policy working.
 *  - A host's own `options.env` arrives on this same channel and is meant
 *    to reach commands. It is indistinguishable from the worker's config
 *    once both are in `process.env`; the prefix is the only thing that
 *    tells them apart.
 *
 * `body.env` is applied AFTER the strip and is not filtered. Inheritance is
 * implicit and gets the default; an explicit per-call value is a caller
 * deciding, including a caller that deliberately sets a prefixed name.
 */
function childEnvironment(requested) {
	const inherited = {}
	for (const key of Object.keys(process.env)) {
		if (key.startsWith(WORKER_CONFIG_PREFIX)) continue
		inherited[key] = process.env[key]
	}
	return { ...inherited, ...(requested || {}) }
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

	// Resolve `cwd` and pre-create it BEFORE we commit to the streaming
	// 200 NDJSON response: both calls can throw (`resolveWithinWorkspace`
	// rejects a host path that escapes the container workspace, and
	// `fs.mkdir` can fail for permission / EROFS / ENOSPC). Without this
	// guard the rejection bubbles out of the http callback, becomes an
	// unhandled promise rejection, and on Node ≥ 15 with the default
	// `unhandledRejection: throw` policy it terminates the worker
	// process. The container exits 1 (`--rm` GCs it), the host's next
	// `fetch` gets `UND_ERR_SOCKET` ("other side closed") and reports
	// it as the bare "fetch failed" the cowork transcripts surfaced —
	// every subsequent tool call in the same supervisor.run() then
	// hits the same dead DNS name and looks like a sandbox-runtime bug
	// when the trigger was a single bad input on a single endpoint.
	let cwd
	try {
		cwd = body.cwd ? resolveWithinWorkspace(body.cwd, WORKSPACE_ROOT) : WORKSPACE_ROOT
	} catch (err) {
		writeJson(res, 400, { error: 'invalid_cwd', message: err.message })
		return
	}
	let timeoutMs
	try {
		timeoutMs = resolveTimeoutMs(body.timeoutMs)
	} catch (err) {
		writeJson(res, 400, { error: 'invalid_timeout', message: err.message })
		return
	}
	const maxOutputBytes = Number(body.maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES
	const start = Date.now()

	try {
		await fs.mkdir(cwd, { recursive: true })
	} catch (err) {
		writeJson(res, 400, { error: 'mkdir_failed', message: err.message })
		return
	}

	res.writeHead(200, {
		'content-type': 'application/x-ndjson; charset=utf-8',
		'cache-control': 'no-store',
	})

	let child
	try {
		child = spawn(body.command, Array.isArray(body.args) ? body.args : [], {
			cwd,
			env: childEnvironment(body.env),
			stdio: [body.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
		})
	} catch (err) {
		// `spawn` throws synchronously for pathologies like an empty
		// command name or an env that contains a `=` in its key.
		// Headers are already on the wire (NDJSON 200), so we cannot
		// downgrade to 400 — emit a terminal `error` event and end
		// the stream like the `child.on('error', …)` path below.
		writeEvent(res, { type: 'error', error: err.message })
		res.end()
		return
	}

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
		const { target, root } = resolveReadablePath(body.path)
		const real = await realpathWithinWorkspace(target, root)
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
		const { target, root } = resolveWritablePath(body.path)
		await fs.mkdir(path.dirname(target), { recursive: true })
		const real = await realpathWithinWorkspace(target, root)
		const buf =
			body.encoding === 'base64'
				? Buffer.from(String(body.content), 'base64')
				: Buffer.from(String(body.content), 'utf8')
		// flag 'wx' rejects existing symlinks pointing out of the workspace
		// only when the target doesn't exist; for existing files we already
		// confirmed via realpath that they resolve inside one of WRITE_ROOTS,
		// so a plain writeFile is safe.
		await fs.writeFile(real, buf)
		writeJson(res, 200, { ok: true, bytesWritten: buf.length })
	} catch (err) {
		writeJson(res, 400, { ok: false, error: err.message })
	}
}

// Idle-exit timer. Reset on every "real work" request (`/execute`,
// `/read-file`, `/write-file`); `/healthz` is deliberately NOT a
// reset — heartbeat liveness pings should not extend a sandbox that's
// otherwise idle. When the timer fires, exit cleanly so the
// container's `--rm` flag triggers daemon-side cleanup. `0` disables
// the layer entirely (testing, hosts that don't want it).
let idleTimer
function resetIdleTimer() {
	if (!IDLE_TIMEOUT_MS || IDLE_TIMEOUT_MS <= 0) return
	if (idleTimer) clearTimeout(idleTimer)
	idleTimer = setTimeout(() => {
		console.log(
			`[namzu-sandbox-worker] idle for ${IDLE_TIMEOUT_MS}ms — exiting (container --rm cleans up)`,
		)
		// Exit code 0: this is intentional shutdown, not a crash. The
		// host's docker logs see a clean exit; the `--rm` flag (set by
		// `@namzu/sandbox` when spawning) collects the container body.
		process.exit(0)
	}, IDLE_TIMEOUT_MS)
	// `unref()` so this timer doesn't keep the event loop alive on its
	// own — process exits naturally if everything else (HTTP server,
	// pending children) settles first.
	idleTimer.unref?.()
}

const server = http.createServer(async (req, res) => {
	try {
		if (req.method === 'GET' && req.url === '/healthz') {
			writeJson(res, 200, { ok: true })
			return
		}
		if (req.method === 'POST' && req.url === '/execute') {
			resetIdleTimer()
			await handleExecute(req, res)
			return
		}
		if (req.method === 'POST' && req.url === '/read-file') {
			resetIdleTimer()
			await handleReadFile(req, res)
			return
		}
		if (req.method === 'POST' && req.url === '/write-file') {
			resetIdleTimer()
			await handleWriteFile(req, res)
			return
		}
		writeJson(res, 404, { error: 'not_found' })
	} catch (err) {
		// Last-line-of-defence: ANY async path that throws past the
		// per-handler try/catch must not be allowed to crash the
		// worker. The container is single-tenant per task; a process
		// exit kills every in-flight supervisor + child agent that
		// shared the cached sandbox handle, and they all fail with
		// the misleading bare `fetch failed`. Respond if the headers
		// are still inflight; otherwise log and drop — the host will
		// see a socket close on that one request and retry whatever
		// it was doing, but the next request lands on a still-alive
		// worker.
		console.error('[namzu-sandbox-worker] uncaught handler error:', err && err.stack ? err.stack : err)
		try {
			if (!res.headersSent) {
				writeJson(res, 500, { error: 'internal', message: err && err.message ? err.message : String(err) })
			} else {
				try { res.end() } catch {}
			}
		} catch {}
	}
})

// Defence-in-depth process-level handlers: log loudly if something
// slips past every try/catch, but DO NOT exit the worker. A caller's
// retry path treats a single 500 / 502 as transient, while a process
// exit produces the catastrophic "every subsequent tool call fetch
// fails because the container is gone" pattern.
process.on('unhandledRejection', (err) => {
	console.error('[namzu-sandbox-worker] unhandledRejection:', err && err.stack ? err.stack : err)
})
process.on('uncaughtException', (err) => {
	console.error('[namzu-sandbox-worker] uncaughtException:', err && err.stack ? err.stack : err)
})

// Bind address picks `0.0.0.0` by default so a sibling container
// (the Vandal app talking to a sandbox spawned via docker.sock on
// the same host) can reach the worker over a docker bridge network.
// Overridable via `NAMZU_SANDBOX_BIND` for the dev case where the
// SDK consumer runs on the docker host itself and prefers loopback.
//
// Trust note: the container is the trust boundary. Listening on
// `0.0.0.0` only matters at the network layer — the docker network
// the worker is attached to is per-deployment policy (a bridge with
// no internet egress, or a `network=none` mode where only docker
// exec talks to the container at all).
const BIND = process.env.NAMZU_SANDBOX_BIND || '0.0.0.0'
server.listen(PORT, BIND, () => {
	console.log(
		`[namzu-sandbox-worker] listening on ${BIND}:${PORT} workspace=${WORKSPACE_ROOT} idleTimeoutMs=${IDLE_TIMEOUT_MS}`,
	)
	// Arm the idle timer at boot. If the host never sends a single
	// `/execute` (e.g. supervisor hangs before its first tool call),
	// the sandbox still bounds its own lifetime.
	resetIdleTimer()
})
