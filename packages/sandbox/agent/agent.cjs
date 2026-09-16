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
 * ## Transport selection (vsock or tcp in prod, unix in dev/test)
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
 *   - TCP: when `NAMZU_AGENT_TCP_PORT` is set the agent listens on that
 *     port on `0.0.0.0`, for a deployment where the host reaches the
 *     guest over a routed network (one pod per sandbox on a container
 *     orchestrator) instead of a host-local socket. Same framing, same
 *     handlers; what changes is that the listener is now reachable by
 *     anything the network lets through, which is why this mode is the
 *     one that pairs with a credential (below).
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
 * ## Authn (opt-in, and absent on the vsock path)
 * The vsock control channel is host↔guest only and never traverses the
 * guest egress netns, so it carries no credential: with neither
 * `NAMZU_AGENT_BIND_TOKEN` nor `NAMZU_AGENT_REQUIRE_TOKEN` set the
 * agent authenticates nothing, exactly as it always has. A routed
 * transport has no such boundary, so a pod-network deployment sets
 * `NAMZU_AGENT_BIND_TOKEN` to a per-instance secret — the pod's own
 * `metadata.uid`, injected by the downward API and learned by the host
 * from the API server — and every op but `healthz` must present it in
 * the request envelope's optional `token` field, from the very first
 * frame. `NAMZU_AGENT_REQUIRE_TOKEN` is the fallback for a deployment
 * that cannot inject one: the agent binds to the first token it is
 * shown and refuses every other one for the life of the process.
 *
 * `token` is an OPTIONAL envelope field, so the wire format is
 * unchanged and {@link FIRECRACKER_AGENT_PROTOCOL_VERSION} is
 * deliberately NOT bumped: no host and no golden image has to roll with
 * this change.
 *
 * Because the credential rides inside the envelope, the gate cannot run
 * until a whole frame has been parsed, so an unauthenticated peer is
 * bounded rather than trusted: a small pre-auth cap on the length a
 * frame header may announce (`NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES`), an
 * ABSOLUTE deadline from accept that no byte resets
 * (`NAMZU_AGENT_PREAUTH_DEADLINE_MS`), an idle timeout beside it
 * (`NAMZU_AGENT_PREAUTH_IDLE_TIMEOUT_MS`), a pre-auth pool that EVICTS
 * ITS OLDEST member rather than turning the newest arrival away
 * (`NAMZU_AGENT_MAX_PREAUTH_CONNECTIONS`), and a refusal that DESTROYS
 * the connection instead of half-closing it. All of them are confined
 * to the token modes; a connection on the vsock or unix path sees none
 * of them. A global ceiling on the announced frame length
 * (`NAMZU_AGENT_MAX_FRAME_BYTES`) applies on every mode, because the
 * 8-hex prefix otherwise lets any peer, authenticated or not, name 4 GiB.
 *
 * The deadline and the eviction are the two that answer a slow loris,
 * and neither is optional. An idle timer cannot: every byte resets it,
 * so a peer trickling one byte every few seconds holds its slot for as
 * long as it likes. A pool that refused the NEWEST connection made that
 * worse rather than better — a poolful of such peers locked out every
 * later caller, the credential-exempt `healthz` probe included. What no
 * bound here can do is stop a peer that can reach the port from causing
 * churn, and that is the point of the division of labour: the network
 * rule in front of the port is the boundary, and all of this is defence
 * in depth behind it.
 *
 * A TCP listener with neither credential variable set is refused at
 * startup rather than bound unauthenticated, and so is an empty
 * `NAMZU_AGENT_BIND_TOKEN`, in any mode.
 *
 * What the token is not: a boundary against the sandbox's own workload.
 * After the image entrypoint deprivileges, the agent and the workload
 * share a uid, so a workload process can read the agent's own
 * `/proc/<pid>/environ`. It is per-instance for exactly that reason —
 * stealing it wins nothing the thief does not already have inside that
 * instance, and there is no shared pool secret whose theft would reach
 * the others.
 */

'use strict'

const net = require('node:net')
const { spawn } = require('node:child_process')
const { createHash, randomUUID, timingSafeEqual } = require('node:crypto')
const fs = require('node:fs/promises')
const { constants: osConstants } = require('node:os')
const path = require('node:path')

const FIRECRACKER_AGENT_PROTOCOL_VERSION = 2

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
// `terminateAndConfirm` only escalates SIGTERM to SIGKILL when the owned
// process group is STILL alive at the end of this window — a group that
// goes quiet before then is read as "the signal worked," with no check
// that the signal was the reason. A command that ignores SIGTERM but
// happens to finish on its own before this elapses therefore runs to
// completion untouched, and is reported back as a clean, unaborted-looking
// result: exactly the outcome `SandboxExecOptions.signal`'s contract
// forbids ("must terminate the owned process ... never silently ignore the
// signal and let the command run to completion"). This was 2000ms until
// issue #469's kind conformance run caught it — every suite that drives
// this path shortens it to 50ms "so the abort case proves the kill in
// milliseconds, not the production window" (see
// `firecracker/__tests__/conformance.test.ts`), which happened to flip
// which side of that race wins for the shared conformance fixture's
// ~400ms-to-finish ignoring process and hid this default's own behaviour
// from every test. Kept short enough to leave that fixture a wide margin;
// a deployment that genuinely needs longer for cooperative cleanup sets
// `NAMZU_AGENT_CANCEL_GRACE_MS` explicitly.
const CANCEL_GRACE_MS = positiveIntegerConfig('NAMZU_AGENT_CANCEL_GRACE_MS', 250, true)
const CANCEL_CONFIRM_TIMEOUT_MS = positiveIntegerConfig(
	'NAMZU_AGENT_CANCEL_CONFIRM_TIMEOUT_MS',
	5_000,
)
const EXECUTION_ID_PATTERN =
	/^exec_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// The largest frame length a peer may ANNOUNCE in the 8-hex prefix. The
// prefix itself allows 0xffffffff — 4 GiB — and the reader used to honour
// it, so one peer could name a length and stream toward it while the agent
// concatenated every byte into one heap buffer. The ceiling has to clear
// the largest frame the host legitimately writes, and that is a
// `write-file`: transport.ts sends the WHOLE body base64-encoded in a
// single envelope (`writeFile`, backends/firecracker/transport.ts), with no
// chunking anywhere on the path. 256 MiB of base64 is a ~192 MiB file —
// orders of magnitude above anything the Firecracker suites send and far
// below what the prefix would otherwise permit.
const MAX_FRAME_BYTES = positiveIntegerConfig('NAMZU_AGENT_MAX_FRAME_BYTES', 256 * 1024 * 1024)
// The same ceiling for a connection that has not yet presented the token,
// and only in the modes where a token is required at all. The gate cannot
// run until a whole frame has been parsed, because the credential rides
// inside the envelope, so without this an UNAUTHENTICATED peer got the
// full post-auth budget.
//
// Sized by what it would otherwise break rather than by what a request
// envelope costs: a `write-file` body travels in the same first frame as
// the token, so this cap IS the write-file ceiling on a token path —
// 8 MiB of frame is a ~6 MiB file. A deployment that writes larger files
// raises the variable; a host that learns to chunk a body across frames
// would let it come back down. See the README.
//
// Clamped to the global ceiling, because a pre-auth budget above the
// post-auth one is not a budget — it reads as a bug the first time
// someone hits the smaller number after authenticating.
const MAX_PREAUTH_FRAME_BYTES = Math.min(
	positiveIntegerConfig('NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES', 8 * 1024 * 1024),
	MAX_FRAME_BYTES,
)
// How many connections may be unauthenticated AT ONCE, in a token mode.
// The cap above bounds what one unauthenticated peer may hold; without
// this it could hold it many times over, once per connection. A
// connection leaves the pool the moment it authenticates, which on a
// healthy host is one round trip after it was accepted, so 64 is far
// above anything a host legitimately has in flight.
//
// A FULL pool gives up its oldest member rather than refusing the
// arrival. Refusing the newest is what makes a connection cap a denial
// of service in its own right: peers that hold their slots without ever
// authenticating then decide who else may be served, and `healthz` is
// answered on a connection like any other. The oldest unauthenticated
// connection is by construction the one that has had the longest to
// present a token and has not.
const MAX_PREAUTH_CONNECTIONS = positiveIntegerConfig('NAMZU_AGENT_MAX_PREAUTH_CONNECTIONS', 64)
// What every unauthenticated connection may buffer BETWEEN THEM, in a
// token mode. The count above bounds sockets; this bounds the heap, and
// the heap is what runs out first: 64 connections each holding a frame
// just under the pre-auth cap is 64 x 8 MiB, which is a bound but not a
// survivable one for a pod. Charged against what the readers actually
// hold rather than against what was announced, so the ordinary case —
// many small envelopes in flight — spends almost none of it, and the
// default still leaves room for four concurrent maximum-size ones. Never
// smaller than one pre-auth frame, or a single legitimate write-file
// could not fit inside the budget it has to pass through.
const MAX_PREAUTH_BUFFER_BYTES = Math.max(
	positiveIntegerConfig('NAMZU_AGENT_MAX_PREAUTH_BUFFER_BYTES', 32 * 1024 * 1024),
	MAX_PREAUTH_FRAME_BYTES,
)
// How long a connection in a token mode may stay unauthenticated while
// QUIET. This is an IDLE timeout: every byte received resets it, so on its
// own it retires only the connection that opens and then says nothing, or
// says too little to parse. It is kept because that connection should go
// early, not because it bounds anything.
const PREAUTH_IDLE_TIMEOUT_MS = positiveIntegerConfig('NAMZU_AGENT_PREAUTH_IDLE_TIMEOUT_MS', 10_000)
// How long a connection in a token mode may stay unauthenticated AT ALL.
// Measured from accept and reset by nothing — this is the bound the idle
// timer above is not. Without it a peer trickling a byte every few seconds
// pushed the idle timer out forever and held its slot indefinitely; enough
// such peers filled the pre-auth pool and, while the pool refused the
// newest arrival rather than evicting its oldest member, starved every
// later caller including `healthz`. A connection clears the deadline the
// moment it authenticates, so no long-lived terminal, `tcp-connect` or
// streaming `execute` is ever measured against it.
const PREAUTH_DEADLINE_MS = positiveIntegerConfig('NAMZU_AGENT_PREAUTH_DEADLINE_MS', 10_000)
// How long a refusal may take to reach the wire before the socket is
// destroyed anyway. The refusal is one small frame on an otherwise idle
// socket, so this is a backstop against a peer that has stopped reading,
// not a budget anything normally uses.
const REFUSAL_FLUSH_GRACE_MS = positiveIntegerConfig('NAMZU_AGENT_REFUSAL_FLUSH_GRACE_MS', 1_000)

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

const EMPTY_CHUNK = Buffer.alloc(0)

// A frame header is exactly nine bytes: eight hex digits and a newline.
// Nothing longer is one, which is what lets the reader decide on the ninth
// byte that a peer streaming bytes with no newline in them is never going
// to produce a header.
const FRAME_HEADER_BYTES = LENGTH_PREFIX_HEX + 1

/**
 * Split a byte stream into `<8-hex length>\n<payload>` frames.
 *
 * The reader is the agent's memory-bounding component: everything an
 * unauthenticated peer can make the agent hold, it holds here. So it
 * keeps arrived chunks as a queue and copies each frame exactly once,
 * rather than concatenating every chunk into one growing buffer — which
 * cost O(n²) in the bytes a peer sent, and handed anyone who could reach
 * the port an amplifier.
 *
 * Two bounds keep the queue small. A header may not announce more than
 * `maxFrameBytes`, and no header may take more than nine bytes to arrive.
 */
class FrameReader {
	/**
	 * @param maxFrameBytes the largest length a header may announce. A
	 * header above it stops the reader dead: nothing further is parsed and
	 * nothing further is buffered, which is what keeps a peer from naming
	 * a length and streaming toward it. The bound is a mutable field
	 * rather than a constructor-fixed one because a connection's budget
	 * legitimately changes — see `handleConnection`, which starts a
	 * token-gated connection at the pre-auth cap and raises it once the
	 * connection has authenticated.
	 */
	constructor(maxFrameBytes = MAX_FRAME_BYTES) {
		/** Arrived chunks, oldest first, starting on a frame boundary. */
		this.chunks = []
		/** What `chunks` holds, so a length check costs no walking. */
		this.length = 0
		this.maxFrameBytes = maxFrameBytes
		/**
		 * `{ announced, limit }` once a header has asked for more than the
		 * cap allowed, otherwise undefined.
		 */
		this.overflow = undefined
	}
	push(chunk) {
		// An overflowing reader takes no more bytes. Re-pushing after the
		// caller has raised `maxFrameBytes` and cleared `overflow` re-parses
		// what is already buffered.
		if (this.overflow) return []
		if (chunk.length > 0) {
			this.chunks.push(chunk)
			this.length += chunk.length
		}
		const out = []
		for (;;) {
			if (this.length < FRAME_HEADER_BYTES) break
			const header = this.peek(FRAME_HEADER_BYTES)
			const nl = header.indexOf(0x0a)
			if (nl !== LENGTH_PREFIX_HEX) {
				// Deciding this here, on the ninth byte, is the whole reason the
				// header is read as a fixed width. Waiting for a newline instead
				// meant a peer who never sent one was never wrong, and every byte
				// it sent was buffered while the agent kept waiting — reachable
				// before any credential had been checked.
				throw new Error(
					nl < 0
						? `malformed frame header (no newline in the first ${FRAME_HEADER_BYTES} bytes)`
						: `malformed frame header (newline at ${nl})`,
				)
			}
			const prefix = header.subarray(0, LENGTH_PREFIX_HEX).toString('ascii')
			if (!/^[0-9a-fA-F]{8}$/.test(prefix)) {
				throw new Error(`invalid frame length header ${JSON.stringify(prefix)}`)
			}
			const len = Number.parseInt(prefix, 16)
			if (len > this.maxFrameBytes) {
				// Recorded rather than thrown: whole frames already parsed out
				// of this same chunk are still valid, and one of them may be
				// the frame that authenticates the connection and raises the
				// cap this header just exceeded.
				this.overflow = { announced: len, limit: this.maxFrameBytes }
				break
			}
			if (this.length < FRAME_HEADER_BYTES + len) break
			this.consume(FRAME_HEADER_BYTES)
			out.push(this.take(len).toString('utf8'))
		}
		return out
	}
	/**
	 * The first `n` buffered bytes as one contiguous buffer, left in the
	 * queue. Only ever called for a header, and a header almost always
	 * lies inside the chunk it arrived in, so the copy is the rare path.
	 */
	peek(n) {
		const first = this.chunks[0]
		if (first.length >= n) return first.subarray(0, n)
		const head = Buffer.allocUnsafe(n)
		let filled = 0
		for (const chunk of this.chunks) {
			const take = Math.min(n - filled, chunk.length)
			chunk.copy(head, filled, 0, take)
			filled += take
			if (filled === n) break
		}
		return head
	}
	/** Drop the first `n` buffered bytes. */
	consume(n) {
		let left = n
		while (left > 0) {
			const first = this.chunks[0]
			if (first.length > left) {
				this.chunks[0] = first.subarray(left)
				break
			}
			left -= first.length
			this.chunks.shift()
		}
		this.length -= n
	}
	/** Take the first `n` buffered bytes out, as one contiguous buffer. */
	take(n) {
		if (n === 0) return EMPTY_CHUNK
		const first = this.chunks[0]
		if (first.length >= n) {
			const head = first.subarray(0, n)
			if (first.length === n) this.chunks.shift()
			else this.chunks[0] = first.subarray(n)
			this.length -= n
			return head
		}
		const out = Buffer.allocUnsafe(n)
		let filled = 0
		while (filled < n) {
			const chunk = this.chunks[0]
			const take = Math.min(n - filled, chunk.length)
			chunk.copy(out, filled, 0, take)
			filled += take
			if (take === chunk.length) this.chunks.shift()
			else this.chunks[0] = chunk.subarray(take)
		}
		this.length -= n
		return out
	}
	/** Drop everything buffered. Used when a connection is given up on. */
	reset() {
		this.chunks = []
		this.length = 0
		this.overflow = undefined
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

/**
 * The environment for a process started to serve a request. Every
 * `NAMZU_AGENT_*` and `NAMZU_SANDBOX_*` variable is dropped, so the
 * agent's own configuration — the bind token among it — never enters
 * the workload's environment. Every process the agent starts to serve
 * a request — an `execute` command, a `terminal` shell, the resize
 * helper behind it — goes through here, with the caller's own `env`
 * layered on top.
 */
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
		protocolVersion: FIRECRACKER_AGENT_PROTOCOL_VERSION,
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
				// Scrubbed too: resize is caller-triggered, and stty needs
				// none of the agent's own configuration to set a winsize.
				env: childEnvironment(),
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
			// Scrubbed exactly like an `execute` child. An interactive shell
			// is the shortest path from the workload to the agent's own
			// configuration — including its bind token — so the terminal
			// never inherits process.env raw. Precedence is unchanged: TERM
			// is a default the caller's own env may override.
			env: childEnvironment({ TERM: 'xterm-256color', ...(body.env || {}) }),
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

// --- per-instance credential gate ------------------------------------------

/**
 * The token this process is bound to, once one exists. Only the
 * trust-on-first-use fallback ever writes it — with
 * `NAMZU_AGENT_BIND_TOKEN` preset the expected value is the
 * environment's and no request can change it. Once bound it is never
 * rebound: a genuinely new instance is a new process (a resumed pod
 * runs a fresh agent), so a rebind could only ever serve a caller that
 * failed the first check.
 */
let boundToken

/**
 * Length- and timing-safe token comparison. `timingSafeEqual` throws on
 * operands of unequal length, and returning early on a length mismatch
 * would leak the bound token's length, so both sides are reduced to a
 * fixed-width digest first and the digests are compared.
 */
function tokensMatch(expected, presented) {
	return timingSafeEqual(
		createHash('sha256').update(expected, 'utf8').digest(),
		createHash('sha256').update(presented, 'utf8').digest(),
	)
}

/**
 * Whether this process requires a credential at all. False is the
 * Firecracker vsock/unix deployment, where the gate, the pre-auth frame
 * cap and the pre-auth idle timeout are all absent and a connection
 * behaves byte-for-byte as it did before any of them existed.
 */
function credentialGateActive() {
	return Boolean(process.env.NAMZU_AGENT_BIND_TOKEN || process.env.NAMZU_AGENT_REQUIRE_TOKEN)
}

/**
 * Refuse to start on a credential configuration that would silently
 * authenticate nothing.
 *
 * A TCP listener is reachable by whatever the network admits, so an
 * unauthenticated one is never what the operator meant; the agent used
 * to bind it anyway and say nothing. And `NAMZU_AGENT_BIND_TOKEN` set
 * to the empty string is the shape a downward-API injection takes when
 * it resolves to nothing — accepting it would open exactly the hole the
 * variable was set to close, in every listen mode, so it is refused in
 * every listen mode.
 *
 * The unix and inherited-fd paths are otherwise untouched: their
 * control channel is host↔guest only and they still require no token.
 */
function assertCredentialConfiguration(listenMode) {
	const preset = process.env.NAMZU_AGENT_BIND_TOKEN
	if (preset !== undefined && preset.length === 0) {
		throw new Error(
			'agent: NAMZU_AGENT_BIND_TOKEN is set but empty — unset it to run without a credential, or set it to a per-instance secret',
		)
	}
	if (listenMode === 'tcp' && !credentialGateActive()) {
		throw new Error(
			'agent: NAMZU_AGENT_TCP_PORT is a routed listener and needs a credential — set NAMZU_AGENT_BIND_TOKEN to a per-instance secret, or NAMZU_AGENT_REQUIRE_TOKEN to bind the first token seen',
		)
	}
}

/**
 * Whether one framed request may run. Three modes, chosen by the
 * environment the agent was started in:
 *
 *   - Neither variable set — every request is authorized. This is the
 *     vsock/unix path, whose control channel is host↔guest only; the
 *     behaviour here is byte-identical to the agent before the gate.
 *   - `NAMZU_AGENT_BIND_TOKEN` set — every request must present that
 *     exact token from its first frame.
 *   - `NAMZU_AGENT_REQUIRE_TOKEN` set with no preset token — the
 *     fallback: bind to the first token seen, refuse every other.
 *
 * `healthz` never reaches here. Readiness probing must work without a
 * secret, and its reply carries nothing but liveness and the protocol
 * version.
 */
function authorizeRequest(req) {
	const preset = process.env.NAMZU_AGENT_BIND_TOKEN
	if (!credentialGateActive()) return true
	const presented = typeof req?.token === 'string' ? req.token : ''
	// An empty token is not a credential: accepting one would let an
	// unauthenticated caller take the first-use binding for itself.
	if (!presented) return false
	const expected = preset || boundToken
	if (!expected) {
		boundToken = presented
		return true
	}
	return tokensMatch(expected, presented)
}

// --- connection dispatch ---------------------------------------------------

/**
 * The accepted connections that are in a token mode and have not yet
 * presented a credential, OLDEST FIRST — a Set iterates in insertion
 * order, which is the whole of the ordering the eviction needs. See
 * {@link MAX_PREAUTH_CONNECTIONS}: the per-connection cap bounds what one
 * unauthenticated peer may hold, and the size of this bounds how many
 * times it may hold it.
 *
 * Each member is the connection's own `{ evict }` handle, so evicting one
 * runs its own refusal against its own socket, reader and timers rather
 * than reaching into them from outside.
 */
const preAuthPool = new Set()

/**
 * What those connections are holding in their frame readers, in bytes.
 * See {@link MAX_PREAUTH_BUFFER_BYTES}.
 */
let preAuthBufferedBytes = 0

function handleConnection(socket) {
	// The gate is read once per connection, not once per frame: a
	// connection's budget must not change underneath it because something
	// edited the environment mid-flight.
	const gated = credentialGateActive()
	const reader = new FrameReader(gated ? MAX_PREAUTH_FRAME_BYTES : MAX_FRAME_BYTES)
	let dispatched = false
	let authorized = !gated
	let activeStream
	let abandoned = false
	let counted = gated
	let chargedBytes = 0
	/** Undefined outside a token mode: nothing else arms a deadline. */
	let deadlineTimer
	// `evict` is a hoisted declaration below; the handle is built here so
	// this connection joins the pool at accept, where its age starts.
	const poolEntry = { evict }
	if (counted) preAuthPool.add(poolEntry)

	/**
	 * Give this connection's place in the pre-auth budgets back — its slot
	 * and every byte it had charged. Called when it authenticates, when it
	 * is given up on, and when it closes, whichever happens first; the flag
	 * makes the rest no-ops.
	 */
	function release() {
		if (!counted) return
		counted = false
		preAuthPool.delete(poolEntry)
		preAuthBufferedBytes -= chargedBytes
		chargedBytes = 0
		// The deadline dies with the pre-auth state it bounds, so an
		// authenticated connection — a terminal, a `tcp-connect`, a
		// long-running `execute` — is never measured against it.
		if (deadlineTimer !== undefined) {
			clearTimeout(deadlineTimer)
			deadlineTimer = undefined
		}
	}

	/**
	 * Stop taking bytes from this peer. Detaching the reader is the point:
	 * while it stayed attached, every chunk a refused peer sent was still
	 * concatenated into its buffer.
	 */
	function abandon() {
		if (abandoned) return
		abandoned = true
		release()
		socket.removeListener('data', onData)
		socket.pause()
		socket.setTimeout(0)
		reader.reset()
	}

	/**
	 * Answer a peer we are not going to serve, then take the connection
	 * down.
	 *
	 * A refusal used to `end()` the socket, which half-closes it: only the
	 * writable side went away, the readable side stayed open, and a
	 * refused peer could keep streaming into the agent for as long as it
	 * liked. So the readable side is stopped first, the one refusal frame
	 * is flushed, and the socket is destroyed the moment that write
	 * completes — or after a short grace, for a peer that has stopped
	 * reading and would otherwise hold the write open.
	 */
	function refuse(reply) {
		abandon()
		if (socket.writableEnded) {
			// A `healthz` on this connection has already ended the writable
			// half, so there is nowhere to put the refusal: `end()` here would
			// be a write-after-end whose error arrives asynchronously and tells
			// nobody anything, and 'finish' has already fired, so the teardown
			// would fall back to the grace timer. Take it down now instead.
			socket.destroy()
			return
		}
		const flushTimer = setTimeout(() => socket.destroy(), REFUSAL_FLUSH_GRACE_MS)
		if (typeof flushTimer.unref === 'function') flushTimer.unref()
		socket.once('close', () => clearTimeout(flushTimer))
		socket.once('finish', () => socket.destroy())
		try {
			socket.end(frame(JSON.stringify(reply)))
		} catch {
			socket.destroy()
		}
	}

	/**
	 * Give this connection's pre-auth slot to a newer arrival, because the
	 * pool was full and this is its oldest member.
	 *
	 * Told, not dropped in silence: an evicted caller that is named the
	 * bound it lost to can raise it, and the frame costs a few dozen bytes
	 * on a connection that is going away either way. `refuse` is what makes
	 * it go away — the readable side stops, the reader is detached, and the
	 * socket is destroyed as soon as that one frame is on the wire or the
	 * flush grace expires.
	 */
	function evict() {
		refuse({
			ok: false,
			error: `too_many_unauthenticated_connections: limit ${MAX_PREAUTH_CONNECTIONS} (NAMZU_AGENT_MAX_PREAUTH_CONNECTIONS)`,
		})
	}

	function onData(chunk) {
		if (abandoned) return
		let pending = chunk
		for (;;) {
			let frames
			try {
				frames = reader.push(pending)
			} catch {
				abandon()
				socket.destroy()
				return
			}
			pending = EMPTY_CHUNK
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
					abandon()
					socket.destroy()
					return
				}
				// `healthz` is exempt from the gate so readiness probing needs
				// no secret — and, for the same reason, exempt from LIFTING
				// it: an unauthenticated probe must not buy itself the
				// post-auth frame budget.
				if (req?.op !== 'healthz') {
					if (!authorizeRequest(req)) {
						refuse({ ok: false, error: 'unauthorized' })
						return
					}
					authorized = true
					release()
					reader.maxFrameBytes = MAX_FRAME_BYTES
					socket.setTimeout(0)
				}
				activeStream = dispatch(socket, req)
			}
			if (counted) {
				// What this connection holds, against what every unauthenticated
				// connection may hold between them. Charged after the fact, so a
				// peer overshoots by at most the chunk that took it over.
				preAuthBufferedBytes += reader.length - chargedBytes
				chargedBytes = reader.length
				if (preAuthBufferedBytes > MAX_PREAUTH_BUFFER_BYTES) {
					refuse({
						ok: false,
						error: `preauth_buffer_exhausted: limit ${MAX_PREAUTH_BUFFER_BYTES} bytes (NAMZU_AGENT_MAX_PREAUTH_BUFFER_BYTES)`,
					})
					return
				}
			}
			if (!reader.overflow) return
			// The frame that raised the cap may have been in this same chunk,
			// ahead of the header that overflowed the old one. Re-parse under
			// the new budget rather than refusing a legitimate peer.
			if (reader.overflow.announced <= reader.maxFrameBytes) {
				reader.overflow = undefined
				continue
			}
			// Named, not just numbered: the cap a caller trips is almost always
			// the pre-auth one, and an operator who is told only a number
			// cannot tell which of the two ceilings to raise.
			const variable = authorized
				? 'NAMZU_AGENT_MAX_FRAME_BYTES'
				: 'NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES'
			refuse({
				ok: false,
				error: `frame_too_large: announced ${reader.overflow.announced} bytes, limit ${reader.overflow.limit} (${variable})`,
			})
			return
		}
	}

	socket.on('data', onData)
	socket.on('close', () => {
		release()
		activeStream?.onClose()
	})
	socket.on('error', () => {
		// A severed connection is not fatal — the listener stays up and
		// the next dial lands fresh (resume invariant).
	})
	if (gated) {
		// Both timers are armed only in a token mode and both are cleared
		// the moment a connection authenticates, so no long-lived terminal,
		// `tcp-connect` or streaming `execute` — on this path or on the
		// Firecracker one — can be aged out by either.
		//
		// The deadline runs from accept and NOTHING resets it. That is the
		// entire point of having it beside an idle timer: `socket.setTimeout`
		// is idle-based, so a peer that trickles a byte every few seconds
		// pushes it out forever and never ages out. The idle timer stays
		// because it retires a silent connection sooner than the deadline
		// would.
		deadlineTimer = setTimeout(() => {
			if (authorized) return
			abandon()
			socket.destroy()
		}, PREAUTH_DEADLINE_MS)
		if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref()
		socket.setTimeout(PREAUTH_IDLE_TIMEOUT_MS)
		socket.on('timeout', () => {
			if (authorized) return
			abandon()
			socket.destroy()
		})
		// A full pool gives up its oldest member instead of turning this one
		// away; see {@link MAX_PREAUTH_CONNECTIONS}. The pool can be over its
		// limit by exactly one here — this connection joined it at the top of
		// this same synchronous accept, and nothing else has run since — so
		// one eviction is the whole of it, and skipping `poolEntry` means a
		// pool holding only this connection evicts nobody.
		if (preAuthPool.size > MAX_PREAUTH_CONNECTIONS) {
			const oldest = preAuthPool.values().next().value
			// Freed synchronously, so this connection is inside the bound
			// before it has read a byte.
			if (oldest !== undefined && oldest !== poolEntry) oldest.evict()
		}
	}
}

function dispatch(socket, req) {
	const op = req?.op
	if (op === 'healthz') {
		writeFrame(socket, {
			ok: !agentRetiring,
			protocolVersion: FIRECRACKER_AGENT_PROTOCOL_VERSION,
			...(agentRetiring ? { retiring: true } : {}),
		})
		socket.end()
		return
	}
	// The credential gate is NOT here. It runs in `handleConnection`, on
	// the connection's first frame, because refusing a caller has to take
	// the whole connection down and only the connection owns the pieces
	// that takes — its reader, its data handler, its pre-auth timer.
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

/**
 * Bind the listen socket for whichever transport this deployment
 * configured, in a fixed precedence: unix path, then the inherited
 * vsock fd, then a TCP port. Resolves with the listening `net.Server`
 * so a caller (and the loopback suites) can read the bound address —
 * a TCP deployment may ask for port 0 and learn the port afterwards.
 *
 * Rejects rather than binds when the configuration would serve a
 * routed listener with no credential; see
 * {@link assertCredentialConfiguration}.
 */
function startListening() {
	return new Promise((resolve, reject) => {
		const unixPath = process.env.NAMZU_AGENT_UNIX_PATH
		const vsockPort = process.env.NAMZU_AGENT_VSOCK_PORT
		const tcpPort = process.env.NAMZU_AGENT_TCP_PORT
		// Every rejection below happens before a `net.Server` exists, so a
		// refused startup leaves no listener object behind to leak or to
		// close.
		if (!unixPath && !vsockPort && !tcpPort) {
			reject(
				new Error(
					'agent: none of NAMZU_AGENT_UNIX_PATH, NAMZU_AGENT_VSOCK_PORT or NAMZU_AGENT_TCP_PORT set',
				),
			)
			return
		}
		const listenMode = unixPath ? 'unix' : vsockPort ? 'vsock' : 'tcp'
		let port
		if (listenMode === 'tcp') {
			port = Number(tcpPort)
			if (!Number.isInteger(port) || port < 0 || port > 65535) {
				reject(
					new Error(
						`agent: NAMZU_AGENT_TCP_PORT must be an integer port in [0, 65535], got ${JSON.stringify(tcpPort)}`,
					),
				)
				return
			}
		}
		try {
			assertCredentialConfiguration(listenMode)
		} catch (error) {
			reject(error)
			return
		}
		server = net.createServer(handleConnection)
		server.on('error', reject)
		if (listenMode === 'unix') {
			// Dev + test loopback peer: plain unix-domain socket.
			fs.rm(unixPath, { force: true })
				.catch(() => {})
				.finally(() => {
					server.listen(unixPath, () => resolve(server))
				})
			return
		}
		if (listenMode === 'vsock') {
			// Production: AF_VSOCK port. Node exposes no AF_VSOCK family,
			// so the rootfs runs the agent behind the kernel vsock→stream
			// bridge that terminates on the host UDS the dialer connects
			// to. From here it is a stream listener on a fd the init
			// service passes in (fd 3) — listen on the inherited handle.
			server.listen({ fd: 3 }, () => resolve(server))
			return
		}
		// Routed network: one sandbox per pod, the host dials
		// <podIP>:<port>. Bound on 0.0.0.0 because the pod's address
		// is assigned to it at admission and is not knowable here.
		// A routable listener is not a trust boundary, which is why
		// `assertCredentialConfiguration` has already refused this mode
		// unless a credential is configured for it.
		server.listen(port, '0.0.0.0', () => resolve(server))
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
	// Kubernetes tier only, but harmless everywhere: this process is PID 1
	// inside a pod's own PID namespace (`k8s/entrypoint.sh` `exec`s straight
	// into it, no init in between), and a signal whose default action is
	// "terminate" is left un-applied by the kernel for PID 1 unless the
	// process installs its own handler — with none registered, SIGTERM did
	// nothing and the pod rode out the full `terminationGracePeriodSeconds`
	// before SIGKILL. No drain: an in-flight exec or open terminal gets no
	// grace window, the same "gone" a caller already has to handle from a
	// pod the cluster removed out from under it.
	process.on('SIGTERM', () => {
		if (server) server.close()
		process.exit(0)
	})
}

// Export the pure pieces so the vitest loopback peer can drive the
// agent in-process without spawning a separate node binary.
module.exports = {
	FIRECRACKER_AGENT_PROTOCOL_VERSION,
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
