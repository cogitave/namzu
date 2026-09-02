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
const { randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const { constants: osConstants } = require('node:os')
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
// `body.timeoutMs` traces back to the bash tool's `timeout` argument, which
// is model-authored input — there is no schema ceiling on it between here
// and the LLM's tool call. Without a hard cap the caller-requested value
// alone decided how long a spawned process could pin CPU/memory in the
// guest, i.e. the one guard meant to bound that resource had no bound
// itself. A request over this is refused, not silently shortened — see
// `resolveTimeoutMs`.
const MAX_TIMEOUT_MS = 30 * 60 * 1000
const LENGTH_PREFIX_HEX = 8

function positiveIntegerConfig(name, fallback, allowZero = false) {
	const value = process.env[name] === undefined ? fallback : Number(process.env[name])
	if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
		throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer`)
	}
	return value
}

const EXECUTION_LEASE_TTL_MS = positiveIntegerConfig('NAMZU_AGENT_EXECUTION_LEASE_TTL_MS', 30_000)
const EXECUTION_TERMINAL_TTL_MS = positiveIntegerConfig(
	'NAMZU_AGENT_EXECUTION_TERMINAL_TTL_MS',
	60_000,
)
const MAX_TRACKED_EXECUTIONS = positiveIntegerConfig('NAMZU_AGENT_MAX_TRACKED_EXECUTIONS', 1_024)
const CANCEL_GRACE_MS = positiveIntegerConfig('NAMZU_AGENT_CANCEL_GRACE_MS', 2_000, true)
const CANCEL_CONFIRM_TIMEOUT_MS = positiveIntegerConfig(
	'NAMZU_AGENT_CANCEL_CONFIRM_TIMEOUT_MS',
	5_000,
)
const EXECUTION_ID_PATTERN =
	/^exec_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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
	return socket.write(frame(JSON.stringify(obj)))
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
			if (!/^[0-9a-fA-F]{8}$/.test(header)) {
				throw new Error(`invalid frame length header ${JSON.stringify(header)}`)
			}
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
		return {
			target: resolveWithinWorkspace(p, WORKSPACE_ROOT),
			root: path.resolve(WORKSPACE_ROOT),
		}
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

// Pure so the loopback test can pin the ceiling without spawning a process.
// Throws (rather than clamping) on an out-of-range request: a caller that
// asked for more than the ceiling and silently got less would believe its
// process was protected for the duration it asked for.
function resolveTimeoutMs(rawTimeoutMs) {
	const timeoutMs = rawTimeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(rawTimeoutMs)
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`timeoutMs must be a finite number in (0, ${MAX_TIMEOUT_MS}]`)
	}
	return timeoutMs
}

function childEnvironment(requested) {
	const inherited = {}
	for (const key of Object.keys(process.env)) {
		if (key.startsWith('NAMZU_AGENT_') || key.startsWith('NAMZU_SANDBOX_')) continue
		inherited[key] = process.env[key]
	}
	return { ...inherited, ...(requested || {}) }
}

// --- execution ownership --------------------------------------------------

const executions = new Map()
let agentRetiring = false

function pruneExecutions(now = Date.now()) {
	for (const [executionId, execution] of executions) {
		if (
			(execution.state === 'reserved' || execution.state === 'terminal') &&
			execution.expiresAt <= now
		) {
			executions.delete(executionId)
		}
	}
}

function makeRoomForReservation() {
	if (executions.size < MAX_TRACKED_EXECUTIONS) return
	const terminal = [...executions.entries()]
		.filter(([, execution]) => execution.state === 'terminal')
		.sort(([, left], [, right]) => left.expiresAt - right.expiresAt)
	for (const [executionId] of terminal) {
		executions.delete(executionId)
		if (executions.size < MAX_TRACKED_EXECUTIONS) return
	}
}

function validateExecutionId(executionId) {
	return typeof executionId === 'string' && EXECUTION_ID_PATTERN.test(executionId)
}

function syntheticCancelledResult(start = Date.now()) {
	return {
		exitCode: 1,
		timedOut: false,
		durationMs: Math.max(0, Date.now() - start),
		stdoutTruncated: false,
		stderrTruncated: false,
	}
}

function rememberTerminal(execution, outcome, result, error) {
	execution.started = execution.started ?? Boolean(execution.child)
	execution.state = 'terminal'
	execution.outcome = outcome
	execution.result = result
	execution.error = error
	execution.expiresAt = Date.now() + EXECUTION_TERMINAL_TTL_MS
	execution.child = undefined
	execution.processGroupId = undefined
	execution.done = undefined
	execution.resolveDone = undefined
	execution.terminationPromise = undefined
}

function terminalPayload(execution) {
	return {
		ok: true,
		state: execution.outcome,
		started: execution.started === true,
		...(execution.result ? { result: execution.result } : {}),
		...(execution.error ? { error: execution.error } : {}),
	}
}

function processGroupAlive(processGroupId) {
	if (!processGroupId) return false
	if (process.platform === 'win32') return true
	try {
		process.kill(-processGroupId, 0)
		return true
	} catch (error) {
		if (error?.code === 'ESRCH') return false
		return true
	}
}

function signalProcessGroup(execution, signal) {
	const processGroupId = execution.processGroupId
	if (!processGroupId || process.platform === 'win32') {
		try {
			execution.child?.kill(signal)
		} catch {}
		return
	}
	try {
		process.kill(-processGroupId, signal)
	} catch (error) {
		if (error?.code !== 'ESRCH') throw error
	}
}

function delay(ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms)
		timer.unref?.()
	})
}

async function waitForGroupExit(processGroupId, deadlineAt) {
	while (processGroupAlive(processGroupId)) {
		const remaining = deadlineAt - Date.now()
		if (remaining <= 0) return false
		await delay(Math.min(25, remaining))
	}
	return true
}

async function waitForDone(execution, deadlineAt) {
	const remaining = deadlineAt - Date.now()
	if (remaining <= 0) throw new Error('execution close was not observed before the deadline')
	let timer
	try {
		return await Promise.race([
			execution.done,
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error('execution close was not observed before the deadline')),
					remaining,
				)
				timer.unref?.()
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

async function terminateAndConfirm(execution, cause) {
	if (execution.state === 'terminal') return terminalPayload(execution)
	if (execution.state === 'exited') {
		await waitForDone(execution, Date.now() + CANCEL_CONFIRM_TIMEOUT_MS)
		return terminalPayload(execution)
	}
	if (execution.state !== 'running') {
		throw new Error(`execution is not running (state=${execution.state})`)
	}
	if (execution.terminationCause === undefined) execution.terminationCause = cause

	const deadlineAt = Date.now() + CANCEL_CONFIRM_TIMEOUT_MS
	signalProcessGroup(execution, 'SIGTERM')
	const termDeadline = Math.min(deadlineAt, Date.now() + CANCEL_GRACE_MS)
	let groupGone = await waitForGroupExit(execution.processGroupId, termDeadline)
	if (!groupGone) {
		if (execution.state === 'exited') {
			throw new Error(
				`process group ${execution.processGroupId} outlived its leader during cancellation; refusing to signal a reusable numeric process-group id`,
			)
		}
		signalProcessGroup(execution, 'SIGKILL')
		groupGone = await waitForGroupExit(execution.processGroupId, deadlineAt)
	}
	if (!groupGone) {
		throw new Error(`process group ${execution.processGroupId} remained live after SIGKILL`)
	}
	await waitForDone(execution, deadlineAt)
	return terminalPayload(execution)
}

function ensureTermination(execution, cause) {
	if (!execution.terminationPromise) {
		execution.terminationPromise = terminateAndConfirm(execution, cause).catch((error) => {
			execution.terminationPromise = undefined
			throw error
		})
	}
	return execution.terminationPromise
}

function retireAgent(error) {
	if (agentRetiring) return
	agentRetiring = true
	console.error(
		`[namzu-fc-agent] termination could not be confirmed; refusing reuse: ${error instanceof Error ? error.message : String(error)}`,
	)
}

function handleReserveExecution(socket) {
	pruneExecutions()
	makeRoomForReservation()
	if (agentRetiring) {
		writeFrame(socket, { ok: false, error: 'agent_retiring' })
		socket.end()
		return
	}
	if (executions.size >= MAX_TRACKED_EXECUTIONS) {
		writeFrame(socket, { ok: false, error: 'execution_capacity' })
		socket.end()
		return
	}
	const executionId = `exec_${randomUUID()}`
	const leaseExpiresAt = Date.now() + EXECUTION_LEASE_TTL_MS
	executions.set(executionId, {
		executionId,
		state: 'reserved',
		expiresAt: leaseExpiresAt,
	})
	writeFrame(socket, {
		ok: true,
		protocolVersion: 2,
		executionId,
		leaseExpiresAt,
	})
	socket.end()
}

async function handleCancelExecution(socket, body) {
	if (!validateExecutionId(body?.executionId)) {
		writeFrame(socket, { ok: false, error: 'invalid_execution_id' })
		return
	}
	pruneExecutions()
	const execution = executions.get(body.executionId)
	if (!execution) {
		writeFrame(socket, { ok: false, error: 'unknown_execution' })
		return
	}
	if (execution.state === 'reserved' || execution.state === 'starting') {
		rememberTerminal(execution, 'cancelled', syntheticCancelledResult(execution.startedAt))
		writeFrame(socket, terminalPayload(execution))
		return
	}
	if (execution.state === 'terminal') {
		writeFrame(socket, terminalPayload(execution))
		return
	}
	try {
		writeFrame(socket, await ensureTermination(execution, 'cancelled'))
	} catch (error) {
		writeFrame(socket, {
			ok: false,
			error: 'cancellation_unconfirmed',
			message: error instanceof Error ? error.message : String(error),
		})
		retireAgent(error)
	}
}

async function handleExecute(socket, body) {
	if (!body || !body.command || typeof body.command !== 'string') {
		writeFrame(socket, { type: 'error', error: 'missing_command' })
		writeTerminator(socket)
		socket.end()
		return
	}
	if (body.executionId !== undefined && !validateExecutionId(body.executionId)) {
		writeFrame(socket, { type: 'error', error: 'invalid_execution_id' })
		writeTerminator(socket)
		socket.end()
		return
	}
	let trackedExecution
	let cwd
	try {
		cwd = body.cwd ? resolveWithinWorkspace(body.cwd, WORKSPACE_ROOT) : WORKSPACE_ROOT
	} catch (err) {
		writeFrame(socket, { type: 'error', error: `invalid_cwd: ${err.message}` })
		writeTerminator(socket)
		socket.end()
		return
	}
	let timeoutMs
	try {
		timeoutMs = resolveTimeoutMs(body.timeoutMs)
	} catch (err) {
		writeFrame(socket, {
			type: 'error',
			error: `invalid_timeout: ${err.message}`,
		})
		writeTerminator(socket)
		socket.end()
		return
	}
	const maxOutputBytes = Number(body.maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES
	const start = Date.now()

	if (body.executionId !== undefined) {
		pruneExecutions()
		trackedExecution = executions.get(body.executionId)
		if (!trackedExecution) {
			writeFrame(socket, { type: 'error', error: 'unknown_execution' })
			writeTerminator(socket)
			socket.end()
			return
		}
		if (trackedExecution.state !== 'reserved') {
			writeFrame(socket, {
				type: 'error',
				error: `execution_not_reserved: ${trackedExecution.state}`,
			})
			writeTerminator(socket)
			socket.end()
			return
		}
		trackedExecution.state = 'starting'
		trackedExecution.startedAt = start
		trackedExecution.expiresAt = undefined
	}

	try {
		await fs.mkdir(cwd, { recursive: true })
	} catch (err) {
		if (trackedExecution?.state === 'starting') {
			rememberTerminal(trackedExecution, 'failed', undefined, err.message)
		}
		writeFrame(socket, {
			type: 'error',
			error: `mkdir_failed: ${err.message}`,
		})
		writeTerminator(socket)
		socket.end()
		return
	}
	if (trackedExecution?.state === 'terminal') {
		writeFrame(socket, { type: 'error', error: 'execution_cancelled' })
		writeTerminator(socket)
		socket.end()
		return
	}

	let child
	try {
		child = spawn(body.command, Array.isArray(body.args) ? body.args : [], {
			cwd,
			env: childEnvironment(body.env),
			stdio: [body.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
			detached: process.platform !== 'win32',
		})
	} catch (err) {
		if (trackedExecution?.state === 'starting') {
			rememberTerminal(trackedExecution, 'failed', undefined, err.message)
		}
		writeFrame(socket, { type: 'error', error: err.message })
		writeTerminator(socket)
		socket.end()
		return
	}
	if (body.stdin !== undefined && child.stdin) child.stdin.end(String(body.stdin))

	const stdout = { bytes: 0, truncated: false }
	const stderr = { bytes: 0, truncated: false }
	let settled = false
	let resolveDone
	const done = new Promise((resolve) => {
		resolveDone = resolve
	})
	const execution = trackedExecution ?? { state: 'starting', startedAt: start }
	Object.assign(execution, {
		state: 'running',
		child,
		processGroupId: child.pid,
		done,
		resolveDone,
		terminationCause: undefined,
	})

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
		const clipped = clip(stdout, chunk)
		if (clipped)
			writeFrame(socket, {
				type: 'stdout_delta',
				data: clipped.toString('utf8'),
			})
	})
	child.stderr.on('data', (chunk) => {
		const clipped = clip(stderr, chunk)
		if (clipped)
			writeFrame(socket, {
				type: 'stderr_delta',
				data: clipped.toString('utf8'),
			})
	})

	const timeout = setTimeout(() => {
		void ensureTermination(execution, 'timeout').catch((error) => {
			retireAgent(error)
		})
	}, timeoutMs)
	timeout.unref()

	function settle(error, result) {
		if (settled) return
		settled = true
		clearTimeout(timeout)
		if (trackedExecution) {
			rememberTerminal(
				trackedExecution,
				execution.terminationCause === 'cancelled' ? 'cancelled' : error ? 'failed' : 'completed',
				result,
				error?.message,
			)
		}
		resolveDone({ error, result })
		try {
			if (error) writeFrame(socket, { type: 'error', error: error.message })
			else writeFrame(socket, { type: 'result', ...result })
			writeTerminator(socket)
			socket.end()
		} catch {}
	}

	child.on('error', (error) => settle(error))
	child.on('exit', (exitCode, signal) => {
		if (execution.state !== 'running') return
		execution.state = 'exited'
		execution.exitCode = exitCode
		execution.exitSignal = signal
	})
	child.on('close', (exitCode, signal) => {
		void (async () => {
			if (settled) return
			execution.state = 'exited'
			if (processGroupAlive(execution.processGroupId)) {
				if (execution.terminationCause !== undefined) {
					const groupGone = await waitForGroupExit(
						execution.processGroupId,
						Date.now() + CANCEL_CONFIRM_TIMEOUT_MS,
					)
					if (!groupGone) {
						throw new Error(
							`process group ${execution.processGroupId} remained live after termination`,
						)
					}
				} else {
					await delay(25)
					if (processGroupAlive(execution.processGroupId)) {
						throw new Error(
							`process group ${execution.processGroupId} remained live after its leader exited; refusing to signal a reusable numeric process-group id`,
						)
					}
				}
			}
			settle(undefined, {
				exitCode: typeof exitCode === 'number' ? exitCode : -1,
				timedOut: execution.terminationCause === 'timeout',
				durationMs: Date.now() - start,
				...(signal ? { signal } : {}),
				stdoutTruncated: stdout.truncated,
				stderrTruncated: stderr.truncated,
			})
		})().catch((error) => {
			retireAgent(error)
			// No terminal frame is truthful here: the owned process group may
			// still be alive. Drop the data connection so the host reconciles
			// through cancel, observes the unconfirmed state, and retires the VM.
			socket.destroy()
		})
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

// --- guest-owned pseudo-terminal ------------------------------------------

const MAX_TERMINAL_COLS = 1000
const MAX_TERMINAL_ROWS = 1000
const TERMINAL_SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'])

/** Quote one argv token for the shell command accepted by util-linux script. */
function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`
}

function terminalDimension(value, max, name) {
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
		throw new Error(`${name} must be an integer in [1, ${max}]`)
	}
	return parsed
}

async function processChildren(pid) {
	try {
		const raw = await fs.readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')
		return raw
			.trim()
			.split(/\s+/)
			.map(Number)
			.filter((value) => Number.isInteger(value) && value > 0)
	} catch {
		return []
	}
}

/**
 * Resolve the slave allocated by util-linux `script`.
 *
 * `script` owns the PTY master and the login shell is its child. The child's
 * fd 0 is therefore the authoritative slave path; discovering it through proc
 * lets resize use the real TIOCSWINSZ ioctl through `stty -F`, including the
 * SIGWINCH programs expect. No pipe is represented as a terminal.
 */
async function findPtySlave(scriptPid) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const queue = await processChildren(scriptPid)
		while (queue.length > 0) {
			const pid = queue.shift()
			try {
				const target = await fs.readlink(`/proc/${pid}/fd/0`)
				if (/^\/dev\/pts\/\d+$/.test(target)) return target
			} catch {}
			queue.push(...(await processChildren(pid)))
		}
		await delay(5)
	}
	throw new Error('terminal PTY slave did not appear')
}

function resizePty(slavePath, cols, rows) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			'/usr/bin/stty',
			['-F', slavePath, 'rows', String(rows), 'cols', String(cols)],
			{
				stdio: 'ignore',
			},
		)
		child.once('error', reject)
		child.once('close', (code) => {
			if (code === 0) resolve()
			else reject(new Error(`stty resize failed with code ${String(code)}`))
		})
	})
}

/**
 * Start one interactive PTY inside the guest and bind it to this framed
 * connection. The runtime gateway owns the connection; disconnect/kill tears
 * down the complete detached process group before the microVM can be released.
 */
function handleTerminal(socket, body) {
	let child
	let slavePath
	let ready = false
	let settled = false
	const pending = []

	const kill = (signal = 'SIGTERM') => {
		if (!child?.pid || settled) return
		const safeSignal = TERMINAL_SIGNALS.has(signal) ? signal : 'SIGTERM'
		try {
			// detached:true makes the script process the process-group leader;
			// negative pid reaches the shell and every descendant, not just script.
			process.kill(-child.pid, safeSignal)
		} catch {}
	}

	const apply = (event) => {
		if (!event || typeof event !== 'object') return
		if (event.type === 'input') {
			if (
				typeof event.data === 'string' &&
				child?.stdin?.writable &&
				!child.stdin.write(event.data)
			) {
				socket.pause()
				child.stdin.once('drain', () => {
					if (!settled) socket.resume()
				})
			}
			return
		}
		if (event.type === 'resize') {
			try {
				const cols = terminalDimension(event.cols, MAX_TERMINAL_COLS, 'cols')
				const rows = terminalDimension(event.rows, MAX_TERMINAL_ROWS, 'rows')
				if (slavePath) void resizePty(slavePath, cols, rows).catch(() => {})
			} catch {}
			return
		}
		if (event.type === 'kill') kill(typeof event.signal === 'string' ? event.signal : 'SIGTERM')
	}

	const start = async () => {
		if (!body || typeof body !== 'object') throw new Error('missing_terminal_options')
		const cols = terminalDimension(body.cols, MAX_TERMINAL_COLS, 'cols')
		const rows = terminalDimension(body.rows, MAX_TERMINAL_ROWS, 'rows')
		const cwd = body.cwd ? resolveWithinWorkspace(body.cwd, WORKSPACE_ROOT) : WORKSPACE_ROOT
		await fs.mkdir(cwd, { recursive: true })

		const command = typeof body.command === 'string' && body.command ? body.command : '/bin/sh'
		const args = Array.isArray(body.args) ? body.args.map(String) : []
		const commandLine = ['exec', shellQuote(command), ...args.map(shellQuote)].join(' ')
		child = spawn('/usr/bin/script', ['-qefc', commandLine, '/dev/null'], {
			cwd,
			env: { ...process.env, TERM: 'xterm-256color', ...(body.env || {}) },
			detached: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		const forward = (source, chunk) => {
			if (!writeFrame(socket, { type: 'data', data: chunk.toString('utf8') })) {
				source.pause()
				socket.once('drain', () => {
					if (!settled) source.resume()
				})
			}
		}
		child.stdout.on('data', (chunk) => forward(child.stdout, chunk))
		child.stderr.on('data', (chunk) => forward(child.stderr, chunk))
		child.once('error', (error) => {
			if (settled) return
			settled = true
			writeFrame(socket, { type: 'error', error: error.message })
			socket.end()
		})
		child.once('close', (exitCode, signal) => {
			if (settled) return
			settled = true
			writeFrame(socket, {
				type: 'exit',
				exitCode: typeof exitCode === 'number' ? exitCode : -1,
				...(signal && osConstants.signals[signal] ? { signal: osConstants.signals[signal] } : {}),
			})
			socket.end()
		})

		slavePath = await findPtySlave(child.pid)
		await resizePty(slavePath, cols, rows)
		ready = true
		writeFrame(socket, { type: 'ready' })
		for (const event of pending.splice(0)) apply(event)
	}

	void start().catch((error) => {
		if (settled) return
		writeFrame(socket, {
			type: 'error',
			error: error instanceof Error ? error.message : String(error),
		})
		kill('SIGKILL')
		settled = true
		socket.end()
	})

	return {
		onFrame(payload) {
			let event
			try {
				event = JSON.parse(payload)
			} catch {
				return
			}
			if (ready) apply(event)
			else pending.push(event)
		},
		onClose() {
			kill('SIGKILL')
		},
	}
}

// --- guest-loopback TCP forwarding ---------------------------------------

function handleTcpConnect(socket, body) {
	const host = body?.host || '127.0.0.1'
	const port = Number(body?.port)
	if (
		(host !== '127.0.0.1' && host !== '::1') ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535
	) {
		writeFrame(socket, { type: 'error', error: 'invalid_loopback_target' })
		socket.end()
		return
	}

	let settled = false
	const upstream = net.createConnection({ host, port })
	const finish = (event) => {
		if (settled) return
		settled = true
		if (event) writeFrame(socket, event)
		upstream.destroy()
		socket.end()
	}

	upstream.once('connect', () => writeFrame(socket, { type: 'ready' }))
	upstream.on('data', (chunk) => {
		if (!writeFrame(socket, { type: 'data', data: chunk.toString('base64') })) {
			upstream.pause()
			socket.once('drain', () => {
				if (!settled) upstream.resume()
			})
		}
	})
	upstream.once('end', () => finish({ type: 'end' }))
	upstream.once('error', (error) => finish({ type: 'error', error: error.message }))

	return {
		onFrame(payload) {
			let event
			try {
				event = JSON.parse(payload)
			} catch {
				return
			}
			if (event?.type === 'data' && typeof event.data === 'string') {
				const bytes = Buffer.from(event.data, 'base64')
				if (bytes.byteLength <= 8 * 1024 * 1024 && !upstream.write(bytes)) {
					socket.pause()
					upstream.once('drain', () => {
						if (!settled) socket.resume()
					})
				}
				return
			}
			if (event?.type === 'end') {
				upstream.end()
				return
			}
			if (event?.type === 'destroy') finish()
		},
		onClose() {
			settled = true
			upstream.destroy()
		},
	}
}

// --- connection dispatch ---------------------------------------------------

function handleConnection(socket) {
	const reader = new FrameReader()
	let dispatched = false
	let activeStream
	socket.on('data', (chunk) => {
		let frames
		try {
			frames = reader.push(chunk)
		} catch {
			socket.destroy()
			return
		}
		for (const payload of frames) {
			if (dispatched) {
				activeStream?.onFrame(payload)
				continue
			}
			dispatched = true
			let req
			try {
				req = JSON.parse(payload)
			} catch {
				socket.destroy()
				return
			}
			activeStream = dispatch(socket, req)
		}
	})
	socket.on('close', () => activeStream?.onClose())
	socket.on('error', () => {
		// A severed connection is not fatal — the listener stays up and
		// the next dial lands fresh (resume invariant).
	})
}

function dispatch(socket, req) {
	const op = req?.op
	if (op === 'healthz') {
		writeFrame(socket, {
			ok: !agentRetiring,
			...(agentRetiring ? { retiring: true } : {}),
		})
		socket.end()
		return
	}
	if (op === 'cancel-execution') {
		handleCancelExecution(socket, req.body)
			.catch((error) => writeFrame(socket, { ok: false, error: error.message }))
			.finally(() => socket.end())
		return
	}
	if (agentRetiring) {
		writeFrame(socket, { ok: false, error: 'agent_retiring' })
		socket.end()
		return
	}
	if (op === 'reserve-execution') {
		handleReserveExecution(socket)
		return
	}
	if (op === 'execute') {
		handleExecute(socket, req.body).catch((error) => {
			try {
				writeFrame(socket, { type: 'error', error: error.message })
				writeTerminator(socket)
				socket.end()
			} catch {}
		})
		return
	}
	if (op === 'terminal') {
		return handleTerminal(socket, req.body)
	}
	if (op === 'tcp-connect') {
		return handleTcpConnect(socket, req.body)
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
			console.error('[namzu-fc-agent] re-listen on resume failed:', err?.message)
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
	resolveTimeoutMs,
}

if (require.main === module) {
	main().catch((err) => {
		console.error('[namzu-fc-agent] fatal:', err?.stack ? err.stack : err)
		process.exit(1)
	})
}
