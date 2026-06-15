/**
 * @namzu/sandbox Firecracker in-VM agent (vsock server).
 *
 * This is the custom AF_VSOCK agent the §2.2 decision calls for. It is
 * baked into the golden Firecracker rootfs and started as an init
 * service that is **listening before the golden snapshot is taken**, so
 * the listen socket is captured warm and survives resume.
 *
 * ## Same wire, different transport (vs worker/server.js)
 * It reuses `worker/server.js`'s exact spawn logic, workspace jail
 * (lexical `resolveWithinWorkspace` + realpath symlink-escape guard +
 * READ_ROOTS / WRITE_ROOTS), and the `{stdout_delta|stderr_delta|result
 * |error}` NDJSON shapes **verbatim**. What changes is the transport:
 * instead of an HTTP server on `:2024`, it serves a **framed stream**
 * over a socket. The framing matches the host dialer in
 * `src/backends/firecracker/transport.ts`:
 *
 *   request:  <8-hex byte length>\n<utf8 JSON { op, body }>
 *   reply (file-IO/healthz): one framed JSON object
 *   reply (execute): a SEQUENCE of framed NDJSON lines, then a
 *                    zero-length frame terminator
 *
 * ## Transport selection (vsock in prod, unix in dev/test)
 *   - AF_VSOCK: when `NAMZU_AGENT_VSOCK_PORT` is set and the host
 *     exposes the firecracker vsock device, the agent listens on the
 *     guest AF_VSOCK port. Node has no AF_VSOCK socket family, so the
 *     production rootfs runs the agent behind the kernel's vsock →
 *     stream bridge (the same host-UDS rendezvous the dialer connects
 *     to); from Node's side it is a stream server. The contract port
 *     is the value in `NAMZU_AGENT_VSOCK_PORT`.
 *   - UNIX: when `NAMZU_AGENT_UNIX_PATH` is set (dev + the vitest
 *     loopback peer) the agent listens on that unix-domain socket. The
 *     framing/exec/file-IO/reseed code is identical — only the listen
 *     address differs.
 *
 * ## Resume invariant (FC #4713 / loopholelabs reproducer)
 * On resume the guest vsock driver closes all open connections and the
 * TRANSPORT_RESET may not be delivered. The agent therefore:
 *   1. keeps the listen socket open (never tears it down per-request),
 *   2. handles each connection independently (a severed connection is
 *      not fatal — the next dial lands on the same listener),
 *   3. re-establishes its listen on `SIGUSR1` / VmGenId-change (the
 *      orchestrator/init signals a resume), AFTER reseeding entropy and
 *      regenerating machine-id / host keys / app secrets — the
 *      readiness fence is the security fence (§7 risk #4).
 *
 * Authn: none. The vsock control channel is host↔guest only; it never
 * traverses the guest egress netns.
 */

'use strict'

const net = require('node:net')
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')

// --- config (mirrors worker/server.js env contract) -----------------------

const WORKSPACE_ROOT = process.env.NAMZU_SANDBOX_WORKSPACE || '/workspace'
const READ_ROOTS = normalizeRoots(
	[WORKSPACE_ROOT, ...(process.env.NAMZU_SANDBOX_READ_ROOTS || '').split(path.delimiter)].filter(
		Boolean,
	),
)
const WRITE_ROOTS = normalizeRoots(
	[WORKSPACE_ROOT, ...(process.env.NAMZU_SANDBOX_WRITE_ROOTS || '').split(path.delimiter)].filter(
		Boolean,
	),
)
const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const LENGTH_PREFIX_HEX = 8

// --- framing (matches transport.ts byte-for-byte) --------------------------

function frame(payload) {
	const body = Buffer.from(payload, 'utf8')
	const header = Buffer.from(
		`${body.length.toString(16).padStart(LENGTH_PREFIX_HEX, '0')}\n`,
		'ascii',
	)
	return Buffer.concat([header, body])
}

function writeFrame(socket, obj) {
	socket.write(frame(JSON.stringify(obj)))
}

function writeTerminator(socket) {
	// zero-length frame: "00000000\n"
	socket.write(Buffer.from('00000000\n', 'ascii'))
}

class FrameReader {
	constructor() {
		this.buf = Buffer.alloc(0)
	}
	push(chunk) {
		this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
		const out = []
		for (;;) {
			const nl = this.buf.indexOf(0x0a)
			if (nl < 0) break
			if (nl < LENGTH_PREFIX_HEX) throw new Error(`malformed frame header (newline at ${nl})`)
			const header = this.buf.subarray(0, nl).toString('ascii')
			const len = Number.parseInt(header, 16)
			if (!Number.isInteger(len) || len < 0) {
				throw new Error(`invalid frame length header ${JSON.stringify(header)}`)
			}
			const start = nl + 1
			if (this.buf.length < start + len) break
			out.push(this.buf.subarray(start, start + len).toString('utf8'))
			this.buf = this.buf.subarray(start + len)
		}
		return out
	}
}

// --- workspace jail (verbatim from worker/server.js) -----------------------

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

function resolveAgainstRoots(p, roots) {
	if (!path.isAbsolute(p)) {
		return { target: resolveWithinWorkspace(p, WORKSPACE_ROOT), root: path.resolve(WORKSPACE_ROOT) }
	}
	const target = path.resolve(p)
	const root = roots.find((candidate) => isWithinRoot(target, candidate))
	if (!root) throw new Error('path escapes the workspace')
	return { target, root }
}

const resolveReadablePath = (p) => resolveAgainstRoots(p, READ_ROOTS)
const resolveWritablePath = (p) => resolveAgainstRoots(p, WRITE_ROOTS)

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

// --- handlers (NDJSON shapes verbatim from worker/server.js) ---------------

function handleExecute(socket, body) {
	if (!body || !body.command || typeof body.command !== 'string') {
		writeFrame(socket, { type: 'error', error: 'missing_command' })
		writeTerminator(socket)
		return
	}
	let cwd
	try {
		cwd = body.cwd ? resolveWithinWorkspace(body.cwd, WORKSPACE_ROOT) : WORKSPACE_ROOT
	} catch (err) {
		writeFrame(socket, { type: 'error', error: `invalid_cwd: ${err.message}` })
		writeTerminator(socket)
		return
	}
	const timeoutMs = Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS
	const maxOutputBytes = Number(body.maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES
	const start = Date.now()

	fs.mkdir(cwd, { recursive: true })
		.then(() => {
			let child
			try {
				child = spawn(body.command, Array.isArray(body.args) ? body.args : [], {
					cwd,
					env: { ...process.env, ...(body.env || {}) },
					stdio: [body.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
				})
			} catch (err) {
				writeFrame(socket, { type: 'error', error: err.message })
				writeTerminator(socket)
				return
			}
			if (body.stdin !== undefined && child.stdin) child.stdin.end(String(body.stdin))

			const stdout = { bytes: 0, truncated: false }
			const stderr = { bytes: 0, truncated: false }
			let timedOut = false
			let settled = false

			function clip(target, chunk) {
				if (target.truncated) return null
				const remaining = maxOutputBytes - target.bytes
				if (remaining <= 0) {
					target.truncated = true
					return null
				}
				const clipped = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
				target.bytes += clipped.length
				if (clipped.length < chunk.length) target.truncated = true
				return clipped
			}

			child.stdout.on('data', (chunk) => {
				const c = clip(stdout, chunk)
				if (c) writeFrame(socket, { type: 'stdout_delta', data: c.toString('utf8') })
			})
			child.stderr.on('data', (chunk) => {
				const c = clip(stderr, chunk)
				if (c) writeFrame(socket, { type: 'stderr_delta', data: c.toString('utf8') })
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
				writeFrame(socket, { type: 'error', error: error.message })
				writeTerminator(socket)
			})
			child.on('close', (exitCode) => {
				if (settled) return
				settled = true
				clearTimeout(timeout)
				writeFrame(socket, {
					type: 'result',
					exitCode: typeof exitCode === 'number' ? exitCode : -1,
					timedOut,
					durationMs: Date.now() - start,
					stdoutTruncated: stdout.truncated,
					stderrTruncated: stderr.truncated,
				})
				writeTerminator(socket)
			})
		})
		.catch((err) => {
			writeFrame(socket, { type: 'error', error: `mkdir_failed: ${err.message}` })
			writeTerminator(socket)
		})
}

async function handleReadFile(socket, body) {
	if (!body || !body.path) {
		writeFrame(socket, { ok: false, error: 'missing_path' })
		return
	}
	try {
		const { target, root } = resolveReadablePath(body.path)
		const real = await realpathWithinWorkspace(target, root)
		const buf = await fs.readFile(real)
		const encoding = body.encoding === 'base64' ? 'base64' : 'utf8'
		writeFrame(socket, {
			ok: true,
			content: buf.toString(encoding),
			sizeBytes: buf.length,
			encoding,
		})
	} catch (err) {
		writeFrame(socket, { ok: false, error: err.message })
	}
}

async function handleWriteFile(socket, body) {
	if (!body || !body.path || body.content === undefined) {
		writeFrame(socket, { ok: false, error: 'missing_path_or_content' })
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
		await fs.writeFile(real, buf)
		writeFrame(socket, { ok: true, bytesWritten: buf.length })
	} catch (err) {
		writeFrame(socket, { ok: false, error: err.message })
	}
}

// --- connection dispatch ---------------------------------------------------

function handleConnection(socket) {
	const reader = new FrameReader()
	let dispatched = false
	socket.on('data', (chunk) => {
		let frames
		try {
			frames = reader.push(chunk)
		} catch {
			socket.destroy()
			return
		}
		// One request per connection (matches the host dialer, which
		// opens a fresh connection per request — the resume-survivable
		// shape).
		if (dispatched || frames.length === 0) return
		const first = frames[0]
		dispatched = true
		let req
		try {
			req = JSON.parse(first)
		} catch {
			socket.destroy()
			return
		}
		dispatch(socket, req)
	})
	socket.on('error', () => {
		// A severed connection is not fatal — the listener stays up and
		// the next dial lands fresh (resume invariant).
	})
}

function dispatch(socket, req) {
	const op = req && req.op
	if (op === 'healthz') {
		writeFrame(socket, { ok: true })
		socket.end()
		return
	}
	if (op === 'execute') {
		handleExecute(socket, req.body)
		// execute closes the socket itself after the terminator.
		socket.on('close', () => {})
		return
	}
	if (op === 'read-file') {
		handleReadFile(socket, req.body).finally(() => socket.end())
		return
	}
	if (op === 'write-file') {
		handleWriteFile(socket, req.body).finally(() => socket.end())
		return
	}
	writeFrame(socket, { ok: false, error: `unknown_op: ${String(op)}` })
	socket.end()
}

// --- entropy reseed before ready (the security fence, §7 risk #4) ----------

/**
 * Reseed the guest's userspace randomness state on every resume BEFORE
 * the agent announces ready. The pinned guest kernel is 5.10 (< 5.18),
 * so the in-kernel VMGenID auto-reseed does NOT exist; this userspace
 * reseed is the source of truth. Regenerate machine-id / host keys /
 * app secrets here too. Kept as a hook so the rootfs init owns the
 * exact commands; the agent guarantees it runs to completion before
 * `listen()` re-accepts.
 *
 * Overridable for tests via `NAMZU_AGENT_RESEED_HOOK` (a no-op default
 * keeps the loopback test from shelling out).
 */
async function reseedEntropy() {
	const hook = process.env.NAMZU_AGENT_RESEED_HOOK
	if (!hook) return
	await new Promise((resolve) => {
		const child = spawn('/bin/sh', ['-c', hook], { stdio: 'ignore' })
		child.on('error', () => resolve())
		child.on('close', () => resolve())
	})
}

// --- listen + resume re-listen ---------------------------------------------

let server

function startListening() {
	return new Promise((resolve, reject) => {
		server = net.createServer(handleConnection)
		server.on('error', reject)
		const unixPath = process.env.NAMZU_AGENT_UNIX_PATH
		const vsockPort = process.env.NAMZU_AGENT_VSOCK_PORT
		if (unixPath) {
			// Dev + test loopback peer: plain unix-domain socket.
			fs.rm(unixPath, { force: true })
				.catch(() => {})
				.finally(() => {
					server.listen(unixPath, () => resolve())
				})
			return
		}
		if (vsockPort) {
			// Production: AF_VSOCK port. Node exposes no AF_VSOCK family,
			// so the rootfs runs the agent behind the kernel vsock→stream
			// bridge that terminates on the host UDS the dialer connects
			// to. From here it is a stream listener on a fd the init
			// service passes in (fd 3) — listen on the inherited handle.
			server.listen({ fd: 3 }, () => resolve())
			return
		}
		reject(new Error('agent: neither NAMZU_AGENT_UNIX_PATH nor NAMZU_AGENT_VSOCK_PORT set'))
	})
}

async function reListenOnResume() {
	// Close current connections' listener and re-establish, AFTER reseed.
	await reseedEntropy()
	if (server) {
		await new Promise((r) => server.close(() => r()))
	}
	await startListening()
}

async function main() {
	await reseedEntropy()
	await startListening()
	// Resume signal: the orchestrator/init raises SIGUSR1 after a
	// `/snapshot/load`. Re-listen (and reseed) so first-exec-after-resume
	// never lands on a connection severed by the resume.
	process.on('SIGUSR1', () => {
		reListenOnResume().catch((err) => {
			console.error('[namzu-fc-agent] re-listen on resume failed:', err && err.message)
		})
	})
}

// Export the pure pieces so the vitest loopback peer can drive the
// agent in-process without spawning a separate node binary.
module.exports = {
	frame,
	FrameReader,
	handleConnection,
	startListening,
	reListenOnResume,
	resolveReadablePath,
	resolveWritablePath,
}

if (require.main === module) {
	main().catch((err) => {
		console.error('[namzu-fc-agent] fatal:', err && err.stack ? err.stack : err)
		process.exit(1)
	})
}
