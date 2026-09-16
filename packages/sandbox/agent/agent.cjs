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

// Capabilities this agent has that the protocol VERSION does not announce.
//
// The version is a compatibility fence — a host that speaks 2 requires a
// guest that speaks exactly 2 — so bumping it to publish an additive,
// optional op field would strand every already-running guest for a feature
// none of them has to use. `healthz` carries the list instead, and a host
// that wants the capability asks for it before it relies on it; a host
// that does not never notices the field.
//
//  - `write-file-parts` — `write-file` accepts a `part` object, so a body
//    larger than one frame can be written as a sequence of appends to a
//    temp file finished by an atomic rename. See `handleWriteFilePart`.
//  - `execution-attach` — `reserve-execution` accepts a caller-chosen
//    `executionId`, `execute` accepts `retainOutput`, and the
//    `attach-execution` op replays and then follows a retained execution's
//    output by byte offset without ever signalling it. See `OutputLog`
//    and `handleAttachExecution`.
//  - `stream-heartbeat` — `terminal` and `tcp-connect` accept a
//    `heartbeatMs` in their open body, echo it in `ready`, and then trade a
//    `{ type: 'heartbeat' }` frame every interval so neither side has to
//    guess whether a silent stream is a quiet shell or a peer that went
//    away. See `armStreamHeartbeat`.
const AGENT_FEATURES = ['write-file-parts', 'execution-attach', 'stream-heartbeat']

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
//
// The ceiling belongs to the OPERATOR, not to this file. Every other
// ownership limit beside it is an environment variable, `worker/server.js`
// already reads this same limit from this same variable, and a deployment
// running a two-hour suite in a workspace could otherwise only raise it by
// rebuilding the guest image. The default is unchanged, so an unconfigured
// guest refuses exactly what it always refused, and `resolveTimeoutMs`
// names the variable in its refusal the way `frame_too_large` names its
// own bound.
const MAX_TIMEOUT_MS = positiveIntegerConfig('NAMZU_SANDBOX_MAX_TIMEOUT_MS', 30 * 60 * 1000)
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
// How much of ONE retained execution's interleaved output the agent keeps,
// and how many executions may hold a retained log at the same time. The
// product is the whole of what this feature can cost the guest's heap:
// 1 MiB x 32 = 32 MiB, inside the 512Mi the shipped workspace template
// gives the container to share with the workload. Both halves are needed.
// Bytes alone would let `NAMZU_AGENT_MAX_TRACKED_EXECUTIONS` (1024 by
// default) multiply the bound by three orders of magnitude; a count alone
// would let one `yes` command eat the container.
//
// A log is created ONLY for an execution whose `execute` asked for
// `retainOutput`, so a guest nobody has asked to retain anything costs
// exactly what it always did.
const EXECUTION_LOG_BYTES = positiveIntegerConfig('NAMZU_AGENT_EXECUTION_LOG_BYTES', 1024 * 1024)
const MAX_RETAINED_OUTPUT_LOGS = positiveIntegerConfig('NAMZU_AGENT_MAX_RETAINED_OUTPUT_LOGS', 32)
// How long a retained execution's record and log outlive the command,
// instead of `NAMZU_AGENT_EXECUTION_TERMINAL_TTL_MS`. Separate because the
// two answer different questions: the 60s one bounds how long a cancel may
// be retried idempotently, and shortening the window a REATTACHING host has
// to that would make the feature useless, while lengthening the cancel
// window for every execution would change a default nobody asked to change.
// Ten minutes is the floor the design calls for — long enough for a host to
// be redeployed and come back for its output.
const EXECUTION_RETAINED_TTL_MS = positiveIntegerConfig(
	'NAMZU_AGENT_EXECUTION_RETAINED_TTL_MS',
	10 * 60 * 1000,
)
// How much unwritten output an ATTACHED reader's socket may hold before
// the agent drops that reader. A reader is an observer, and an observer
// that has stopped draining must not be able to grow the guest's heap
// outside the accounting above: everything it misses is in the log, and
// its next attach replays from the offset it last saw. One log's worth is
// the bound, because a reader further behind than that has nothing left
// to catch up TO.
const ATTACH_WRITE_BUFFER_BYTES = EXECUTION_LOG_BYTES
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
// `write-file`: transport.ts sends the whole body base64-encoded in a
// single envelope (`writeFile`, backends/firecracker/transport.ts) whenever
// it fits, and splits it into parts that each fit when it does not. 256 MiB
// of base64 is a ~192 MiB file — orders of magnitude above anything the
// Firecracker suites send and far below what the prefix would otherwise
// permit.
const MAX_FRAME_BYTES = positiveIntegerConfig('NAMZU_AGENT_MAX_FRAME_BYTES', 256 * 1024 * 1024)
// The same ceiling for a connection that has not yet presented the token,
// and only in the modes where a token is required at all. The gate cannot
// run until a whole frame has been parsed, because the credential rides
// inside the envelope, so without this an UNAUTHENTICATED peer got the
// full post-auth budget.
//
// Sized by what it would otherwise break rather than by what a request
// envelope costs: a `write-file` body travels in the same first frame as
// the token, so this cap is the ceiling on ONE write-file frame on a token
// path — 8 MiB of frame is a ~6 MiB file. It is no longer the ceiling on a
// file: a host that sees `write-file-parts` in the healthz reply splits a
// larger body into parts that each fit here and finishes with an atomic
// rename (see `handleWriteFilePart`), so this variable bounds what an
// unauthenticated connection may spend without bounding what a caller may
// write. See the README.
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
		throw new Error(
			`timeoutMs must be a finite number in (0, ${MAX_TIMEOUT_MS}] (NAMZU_SANDBOX_MAX_TIMEOUT_MS)`,
		)
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

// --- retained output ------------------------------------------------------

/**
 * ONE ordered, size-bounded log of a command's output, addressed by a
 * monotonically increasing byte offset.
 *
 * This is the guest's only retained-output primitive. `attach-execution`
 * reads it here; a later persistent-session op reads the same class rather
 * than a second one, because two registries would mean two overflow
 * accountings, two sweeps and two ways to read an offset — and a reader
 * that had to know which one it was talking to.
 *
 * The shape, and why each part of it is there:
 *
 *  - **One offset space for both streams.** stdout and stderr are appended
 *    to the same log and share one cursor, so a reader resumes with a
 *    single number and the interleaving it sees on reattach is the
 *    interleaving the command produced. A per-stream offset would need two
 *    cursors and could not express "these arrived in this order".
 *  - **Offsets are absolute and never rewound.** `endOffset` counts every
 *    byte ever appended, including bytes that have since been evicted, so
 *    an offset a reader was handed stays meaningful after eviction: it
 *    either still points into the log or names exactly how much it missed.
 *  - **Eviction is reported, never silent.** Dropping the oldest bytes
 *    advances `startOffset`, and a read from before it answers with a
 *    `droppedBytes` count. A reader is told what it lost; it is never
 *    handed a shorter stream that looks complete.
 *  - **The bound is bytes, not chunks.** A single chunk larger than the
 *    whole budget has its head sliced off rather than being kept whole, so
 *    `maxBytes` is a real ceiling on what one command can cost.
 *
 * Chunks are held as `Buffer`s: offsets are byte offsets, and a slice taken
 * to honour the ceiling has to be a byte slice. A slice can land inside a
 * multi-byte character exactly as a socket read already can, which is why
 * the gap is reported — nothing here pretends the surviving bytes are a
 * whole string.
 */
class OutputLog {
	constructor(maxBytes) {
		this.maxBytes = maxBytes
		/** @type {{ stream: string, data: Buffer, offset: number }[]} */
		this.chunks = []
		/** Bytes currently held. */
		this.bytes = 0
		/** Offset of the oldest byte still held. */
		this.startOffset = 0
		/** Offset one past the newest byte ever appended. */
		this.endOffset = 0
		/** Total bytes evicted over this log's life. */
		this.droppedBytes = 0
	}

	/** Append one chunk and return the offset it starts at. */
	append(stream, data) {
		const offset = this.endOffset
		if (data.length > 0) {
			this.chunks.push({ stream, data, offset })
			this.bytes += data.length
			this.endOffset += data.length
			this.trim(this.maxBytes)
		}
		return offset
	}

	/**
	 * Give up everything held, keeping the offsets. Used to make room for a
	 * new retained execution without losing the fact that output existed:
	 * a later read reports the whole of it as a gap.
	 */
	discard() {
		this.trim(0)
	}

	/** Evict from the front until at most `budget` bytes remain. */
	trim(budget) {
		while (this.bytes > budget && this.chunks.length > 0) {
			const first = this.chunks[0]
			const excess = this.bytes - budget
			if (first.data.length <= excess) {
				this.chunks.shift()
				this.bytes -= first.data.length
				this.startOffset += first.data.length
				this.droppedBytes += first.data.length
				continue
			}
			first.data = first.data.subarray(excess)
			first.offset += excess
			this.bytes -= excess
			this.startOffset += excess
			this.droppedBytes += excess
		}
	}

	/**
	 * Everything retained from `fromOffset` on, plus the size of the gap
	 * between what was asked for and what survives.
	 *
	 * An offset ahead of `endOffset` is refused rather than clamped: it
	 * names bytes that do not exist yet, and answering it with "nothing,
	 * and no gap" would let a reader with a stale cursor believe it was
	 * caught up.
	 */
	read(fromOffset) {
		if (!Number.isSafeInteger(fromOffset) || fromOffset < 0 || fromOffset > this.endOffset) {
			return undefined
		}
		const droppedBytes = Math.max(0, this.startOffset - fromOffset)
		const start = Math.max(fromOffset, this.startOffset)
		const chunks = []
		for (const chunk of this.chunks) {
			const end = chunk.offset + chunk.data.length
			if (end <= start) continue
			if (chunk.offset >= start) {
				chunks.push(chunk)
				continue
			}
			const skip = start - chunk.offset
			chunks.push({ stream: chunk.stream, data: chunk.data.subarray(skip), offset: start })
		}
		return { chunks, droppedBytes, fromOffset: start, nextOffset: this.endOffset }
	}
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
	// An execution whose output is retained keeps its record for the longer
	// window, because the point of retention is that the host that started
	// it may be gone and may come back. Everything else keeps the 60s
	// idempotent-cancel window it always had.
	execution.expiresAt =
		Date.now() + (execution.log ? EXECUTION_RETAINED_TTL_MS : EXECUTION_TERMINAL_TTL_MS)
	execution.child = undefined
	execution.processGroupId = undefined
	execution.done = undefined
	execution.resolveDone = undefined
	execution.terminationPromise = undefined
	// Every terminal transition goes through here, so every attached reader
	// is answered from here and there is no path that settles an execution
	// while an observer is still waiting on it.
	broadcastTerminal(execution)
}

// --- retained-output accounting and attached readers ----------------------

/** Executions still holding bytes-worth of retained output. */
function retainedLogCount() {
	let count = 0
	for (const execution of executions.values()) {
		if (execution.log && !execution.log.discarded) count += 1
	}
	return count
}

/**
 * Make a retained-output slot available, by giving up the logs of the
 * OLDEST-expiring finished executions. Answers whether there is room now.
 *
 * A finished execution gives up its output and keeps its record: its result
 * is what a late reader most needs, it costs almost nothing to keep, and a
 * reader that attaches afterwards is told the whole log is a gap rather
 * than being told the execution never existed. A slot held by a RUNNING
 * execution is not taken — its output has nowhere else to go — so a guest
 * already retaining `MAX_RETAINED_OUTPUT_LOGS` live commands refuses the
 * next one before it starts a process.
 */
function makeRoomForRetainedOutput() {
	if (retainedLogCount() < MAX_RETAINED_OUTPUT_LOGS) return true
	const finished = [...executions.values()]
		.filter(
			(execution) => execution.log && !execution.log.discarded && execution.state === 'terminal',
		)
		.sort((left, right) => left.expiresAt - right.expiresAt)
	for (const execution of finished) {
		execution.log.discard()
		execution.log.discarded = true
		if (retainedLogCount() < MAX_RETAINED_OUTPUT_LOGS) return true
	}
	return false
}

/** The one terminal frame an `attach-execution` stream ends with. */
function attachResultFrame(execution) {
	return {
		type: 'attach_result',
		executionId: execution.executionId,
		outcome: execution.outcome,
		started: execution.started === true,
		...(execution.result ? { result: execution.result } : {}),
		...(execution.error ? { error: execution.error } : {}),
		nextOffset: execution.log ? execution.log.endOffset : 0,
	}
}

/**
 * Append one output chunk to the retained log and hand it to every reader
 * attached right now.
 *
 * The append happens first and returns the span the chunk occupies, so a
 * live reader is told the same offsets a replaying one would compute. An
 * attach takes its replay and joins this set in one synchronous step (see
 * `handleAttachExecution`), which is what makes the two exact complements:
 * no chunk can be both replayed and broadcast, and none can fall between.
 */
function recordOutput(execution, stream, data) {
	if (!execution.log) return undefined
	const offset = execution.log.append(stream, data)
	// Both ends of the chunk, measured in the log's own byte space. The
	// caller stamps them on the frame it sends, because a host cannot
	// recover them from the string: `toString('utf8')` on a chunk that
	// ends mid-character yields U+FFFD, which is WIDER than the bytes it
	// replaced, so a host counting the decoded string drifts ahead of this
	// log and its reattach either skips bytes nobody reports or names an
	// offset that was never real.
	const span = { offset, nextOffset: offset + data.length }
	if (!execution.attachments || execution.attachments.size === 0) return span
	const event = { type: `${stream}_delta`, data: data.toString('utf8'), ...span }
	for (const attachment of execution.attachments) {
		// A reader whose socket has gone away is not this command's problem:
		// an attach is an observer, and losing one changes nothing about the
		// process. Its `onClose` removes it from the set either way.
		try {
			writeFrame(attachment.socket, event)
			// Nor is a reader that has stopped draining. Dropping it bounds
			// what one observer can buffer in the guest; it reattaches from
			// its own offset and the log replays what it missed.
			if (attachment.socket.writableLength > ATTACH_WRITE_BUFFER_BYTES) {
				execution.attachments.delete(attachment)
				attachment.socket.destroy()
			}
		} catch {}
	}
	return span
}

/** Answer and close every attached reader. Never signals anything. */
function broadcastTerminal(execution) {
	if (!execution.attachments || execution.attachments.size === 0) return
	const event = attachResultFrame(execution)
	for (const attachment of execution.attachments) {
		try {
			writeFrame(attachment.socket, event)
			writeTerminator(attachment.socket)
			attachment.socket.end()
		} catch {}
	}
	execution.attachments.clear()
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

/**
 * Reserve an execution id, or report the one the caller named.
 *
 * With no `executionId` in the body this is exactly the call it has always
 * been, down to the fields in the reply: the agent mints the id and the
 * reply carries no `state`, so a host that has never heard of any of this
 * reads the bytes it always read.
 *
 * With one, the id is the CALLER's, and reserving an id the agent still
 * holds reports what it holds rather than minting a second reservation.
 * That is what makes a retried start idempotent: the second caller sees
 * `state: 'running'` (or `'terminal'`) instead of `'reserved'`, sends no
 * `execute`, and attaches. `handleExecute` refuses a non-reserved id from
 * the other side, so even a caller that ignores the state cannot start the
 * command twice.
 *
 * Idempotency ends where the record does: at `pruneExecutions` (the
 * retention window) and at pod replacement, which takes the whole registry
 * with it. Both are stated in the docs.
 */
function handleReserveExecution(socket, body) {
	pruneExecutions()
	if (agentRetiring) {
		writeFrame(socket, { ok: false, error: 'agent_retiring' })
		socket.end()
		return
	}
	const requested = body?.executionId
	if (requested !== undefined && !validateExecutionId(requested)) {
		writeFrame(socket, { ok: false, error: 'invalid_execution_id' })
		socket.end()
		return
	}
	// Asked BEFORE making room, so a re-reservation cannot evict the very
	// record it is asking about.
	const existing = requested === undefined ? undefined : executions.get(requested)
	if (existing !== undefined) {
		writeFrame(socket, {
			ok: true,
			protocolVersion: FIRECRACKER_AGENT_PROTOCOL_VERSION,
			executionId: requested,
			// Meaningless once a command has started — the lease is what
			// bounds an UNUSED reservation — and reported anyway so the field
			// is always a finite number, as every host that parses this reply
			// requires. `state` is what a caller reads here.
			leaseExpiresAt: existing.expiresAt ?? Date.now(),
			state: existing.state,
			...(existing.log ? { retainedOutput: true, outputOffset: existing.log.endOffset } : {}),
		})
		socket.end()
		return
	}
	makeRoomForReservation()
	if (executions.size >= MAX_TRACKED_EXECUTIONS) {
		writeFrame(socket, { ok: false, error: 'execution_capacity' })
		socket.end()
		return
	}
	const executionId = requested ?? `exec_${randomUUID()}`
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
		// Only for a caller that named an id: the default reserve's reply
		// stays byte-for-byte what it was.
		...(requested === undefined ? {} : { state: 'reserved' }),
	})
	socket.end()
}

/**
 * Replay and then follow one execution's retained output, and end with its
 * result.
 *
 * It is an OBSERVER and nothing else. It never signals the process, never
 * changes the execution's state, and closing the connection removes the
 * reader and does nothing else — deliberately unlike `cancel-execution`,
 * which is the op for ending a command and stays the only one.
 *
 * Synchronous on purpose: the replay is taken and the reader joins the live
 * set in one step with no `await` between them, so no chunk is both
 * replayed and broadcast and none falls between the two.
 */
function handleAttachExecution(socket, body) {
	const refuse = (error, extra) => {
		writeFrame(socket, { type: 'error', error, ...extra })
		writeTerminator(socket)
		socket.end()
	}
	if (!validateExecutionId(body?.executionId)) {
		refuse('invalid_execution_id')
		return
	}
	pruneExecutions()
	const execution = executions.get(body.executionId)
	if (execution === undefined) {
		// Past retention, or in a pod this execution never ran in. Both are
		// the same answer from here, and the docs say so.
		refuse('unknown_execution')
		return
	}
	if (!execution.log) {
		// The state goes with the refusal because it is the difference
		// between two facts a caller must not confuse: an execution still
		// `reserved` has no log because the command NEVER STARTED, while
		// any other state means this command simply kept no output. The
		// host says which one in its error.
		refuse('output_not_retained', { state: execution.state })
		return
	}
	const fromOffset = body.fromOffset === undefined ? 0 : Number(body.fromOffset)
	const replay = execution.log.read(fromOffset)
	if (replay === undefined) {
		refuse('invalid_offset')
		return
	}
	writeFrame(socket, {
		type: 'attached',
		executionId: execution.executionId,
		state: execution.state,
		fromOffset: replay.fromOffset,
		// The bytes between what the reader asked for and what survives. A
		// gap is REPORTED; output is never quietly skipped.
		droppedBytes: replay.droppedBytes,
	})
	for (const chunk of replay.chunks) {
		writeFrame(socket, {
			type: `${chunk.stream}_delta`,
			data: chunk.data.toString('utf8'),
			offset: chunk.offset,
			// The end of the chunk, so a reader that loses this connection
			// after the frame resumes exactly here. It cannot be computed
			// from `data`: see `recordOutput`.
			nextOffset: chunk.offset + chunk.data.length,
		})
	}
	if (execution.state === 'terminal') {
		writeFrame(socket, attachResultFrame(execution))
		writeTerminator(socket)
		socket.end()
		return
	}
	const attachment = { socket }
	execution.attachments.add(attachment)
	return {
		// An attach carries no further request frames. Anything after the
		// first one is a peer this op has no conversation with.
		onFrame: () => {
			execution.attachments.delete(attachment)
			socket.destroy()
		},
		onClose: () => {
			execution.attachments.delete(attachment)
		},
	}
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
	// Retention is addressed by execution id and by nothing else: a log
	// nobody can name is a log nobody can attach to, so asking for one
	// without an id is a caller mistake, not a silently-ignored field.
	if (body.retainOutput === true && body.executionId === undefined) {
		writeFrame(socket, { type: 'error', error: 'retain_requires_execution_id' })
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
		if (body.retainOutput === true) {
			// Refused BEFORE the reservation is spent and before a process
			// exists, so a guest at its retained-output ceiling turns the
			// command away rather than running one whose output it cannot
			// keep. The reservation is left intact for the caller to retry.
			if (!makeRoomForRetainedOutput()) {
				writeFrame(socket, {
					type: 'error',
					error: `retained_output_capacity: limit ${MAX_RETAINED_OUTPUT_LOGS} (NAMZU_AGENT_MAX_RETAINED_OUTPUT_LOGS)`,
				})
				writeTerminator(socket)
				socket.end()
				return
			}
			trackedExecution.log = new OutputLog(EXECUTION_LOG_BYTES)
			trackedExecution.attachments = new Set()
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

	// The retained log is written BEFORE the frame that goes to the
	// connection which started the command, and deliberately: this
	// connection can already be a socket that is going away, while the log
	// is what a reattaching host will read. A write that fails must not be
	// able to cost the log a chunk. `recordOutput` is a no-op unless this
	// execution asked for retention, so the ordinary path is unchanged.
	child.stdout.on('data', (chunk) => {
		const clipped = clip(stdout, chunk)
		if (!clipped) return
		// `span` is present only for a retained execution, so an ordinary
		// execute stream carries exactly the fields it always carried. When
		// it IS present the host reads its cursor off it rather than
		// counting the decoded string — see `recordOutput`.
		const span = recordOutput(execution, 'stdout', clipped)
		writeFrame(socket, {
			type: 'stdout_delta',
			data: clipped.toString('utf8'),
			...(span ?? {}),
		})
	})
	child.stderr.on('data', (chunk) => {
		const clipped = clip(stderr, chunk)
		if (!clipped) return
		// Stamped for the same reason stdout is: one interleaved offset
		// space, one cursor, and neither stream may advance it by guesswork.
		const span = recordOutput(execution, 'stderr', clipped)
		writeFrame(socket, {
			type: 'stderr_delta',
			data: clipped.toString('utf8'),
			...(span ?? {}),
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

/**
 * Temp files a part sequence is currently appending to, keyed by the
 * RESOLVED guest path.
 *
 * The offset check alone already refuses a lost, duplicated or reordered
 * part, but two writers appending to the same temp file concurrently could
 * both read the size the other is about to change and both believe their
 * offset matched. A part is short and the host sends its own parts
 * sequentially, so refusing the overlap outright costs a correct caller
 * nothing and removes the race rather than narrowing it.
 */
const writePartsInFlight = new Set()

/**
 * The host's own temp-file naming (`writeFilePartTempPath`,
 * backends/firecracker/transport.ts).
 *
 * `part.discard` is the only verb on `write-file` that REMOVES a file, and
 * the only thing it exists to remove is a part file this agent created for
 * a sequence that was abandoned. Matching the name — against the RESOLVED
 * path, so a symlink named like a part file does not launder the check —
 * keeps `write-file` from quietly becoming a general delete.
 *
 * `[\s\S]` rather than `.`, which does not match a newline: a target whose
 * basename contains one still gets a temp file, and a pattern that could
 * not name it would strand that file inside the workspace forever.
 */
const WRITE_PART_TEMP_NAME = /^\.namzu-write-[\s\S]+\.part$/

function decodeWriteBody(body) {
	return body.encoding === 'base64'
		? Buffer.from(String(body.content), 'base64')
		: Buffer.from(String(body.content), 'utf8')
}

/**
 * Remove one abandoned part file, and nothing else.
 *
 * The host sends this after a sequence it could not finish, and swallows
 * whatever comes back — the reason the sequence failed is usually the
 * reason the cleanup will fail too. So everything that means "there is no
 * such part file" answers success, including a directory that does not
 * exist because the first part never landed; a host retrying a cleanup is
 * never told it failed at something that was already done.
 *
 * The name is checked twice on purpose: lexically first, so a path that
 * was never a part file is refused as one whether or not it exists, and
 * again on the RESOLVED path, so a symlink named like a part file cannot
 * launder the check into removing something else.
 */
async function discardWritePartFile(socket, target, root) {
	if (!WRITE_PART_TEMP_NAME.test(path.basename(target))) {
		writeFrame(socket, { ok: false, error: 'write_part_not_a_temp_file' })
		return
	}
	let real
	try {
		real = await realpathWithinWorkspace(target, root)
	} catch (err) {
		if (err && err.code === 'ENOENT') {
			writeFrame(socket, { ok: true, discarded: true })
			return
		}
		writeFrame(socket, { ok: false, error: err.message })
		return
	}
	if (!WRITE_PART_TEMP_NAME.test(path.basename(real))) {
		writeFrame(socket, { ok: false, error: 'write_part_not_a_temp_file' })
		return
	}
	try {
		await fs.rm(real, { force: true })
		writeFrame(socket, { ok: true, discarded: true })
	} catch (err) {
		writeFrame(socket, { ok: false, error: err.message })
	}
}

/**
 * One slice of a body too large for a single frame.
 *
 * `body.path` names the TEMP file, never the target — so it goes through
 * the SAME `resolveWritablePath` + `realpathWithinWorkspace` jail checks
 * every other write does, and an agent that did not understand `part` at
 * all would overwrite a temp file rather than the caller's target. The
 * target is named separately by `part.renameTo`, checked the same way, and
 * only ever touched by the final `rename` — so a reader never observes a
 * half-written file and an abandoned sequence leaves the target exactly as
 * it was.
 *
 * `part.offset` must equal the temp file's CURRENT size (offset 0 creates
 * or truncates it). That is what makes a part sequence verifiable rather
 * than hopeful: a part that went missing, arrived twice, or arrived out of
 * order is refused, not appended in the wrong place.
 */
async function handleWriteFilePart(socket, body, part) {
	let target
	let root
	try {
		const resolved = resolveWritablePath(body.path)
		target = resolved.target
		root = resolved.root
	} catch (err) {
		writeFrame(socket, { ok: false, error: err.message })
		return
	}

	// Abandoning a sequence is a write-file too: the host has no other op
	// that can reach into the jail to remove what it left behind. Only a
	// part file, though — see `WRITE_PART_TEMP_NAME` — and it answers
	// before the `mkdir` below ever runs: a verb whose whole job is to
	// leave nothing behind must not create directories on its way to
	// deciding there was nothing there.
	if (part.discard === true) {
		await discardWritePartFile(socket, target, root)
		return
	}

	let real
	try {
		await fs.mkdir(path.dirname(target), { recursive: true })
		real = await realpathWithinWorkspace(target, root)
	} catch (err) {
		writeFrame(socket, { ok: false, error: err.message })
		return
	}

	if (body.content === undefined) {
		writeFrame(socket, { ok: false, error: 'missing_path_or_content' })
		return
	}
	const offset = part.offset === undefined ? 0 : part.offset
	if (!Number.isSafeInteger(offset) || offset < 0) {
		writeFrame(socket, {
			ok: false,
			error: `write_part_invalid_offset: ${JSON.stringify(part.offset)}`,
		})
		return
	}
	const final = part.final === true
	if (final && !part.renameTo) {
		writeFrame(socket, { ok: false, error: 'write_part_missing_rename_target' })
		return
	}
	// Resolved through the jail BEFORE a byte is written, so a final part
	// naming a target outside the workspace is a true no-op rather than a
	// refusal that already appended to the temp file.
	let realTarget
	if (final) {
		try {
			const { target: renameTarget, root: renameRoot } = resolveWritablePath(part.renameTo)
			await fs.mkdir(path.dirname(renameTarget), { recursive: true })
			realTarget = await realpathWithinWorkspace(renameTarget, renameRoot)
		} catch (err) {
			writeFrame(socket, { ok: false, error: err.message })
			return
		}
	}
	if (writePartsInFlight.has(real)) {
		writeFrame(socket, { ok: false, error: 'write_part_in_flight' })
		return
	}

	writePartsInFlight.add(real)
	let handle
	try {
		const buf = decodeWriteBody(body)
		if (offset === 0) {
			handle = await fs.open(real, 'w')
		} else {
			let size = -1
			try {
				size = (await fs.stat(real)).size
			} catch {
				size = -1
			}
			if (size !== offset) {
				throw new Error(
					`write_part_offset_mismatch: temp file is ${size < 0 ? 'absent' : `${size} bytes`}, part starts at offset ${offset}`,
				)
			}
			handle = await fs.open(real, 'r+')
		}
		// One `pwrite`, not a loop: Linux returns a SHORT count and NO
		// error when a write crosses the filesystem's free space or the
		// process's RLIMIT_FSIZE. Reporting the length that was REQUESTED
		// and renaming anyway would put a truncated file onto the target —
		// destroying exactly what the atomic rename exists to protect —
		// while telling the host the write failed. So the bytes are counted
		// twice, by the syscall and by the file itself, and both must agree
		// with what this part claimed BEFORE anything is renamed. A short
		// write on an earlier part is caught by the next part's offset
		// check; the final part has no next part, and is the whole reason
		// this check is here.
		const written = await handle.write(buf, 0, buf.length, offset)
		const sizeBytes = (await handle.stat()).size
		await handle.close()
		handle = undefined
		if (written.bytesWritten !== buf.length || sizeBytes !== offset + buf.length) {
			throw new Error(
				`write_part_short_write: wrote ${written.bytesWritten} of ${buf.length} bytes at offset ${offset}, temp file is ${sizeBytes} bytes`,
			)
		}
		if (final) {
			// Same directory by construction (the host names a sibling), so
			// this is a rename within one filesystem: atomic, and the only
			// moment the target changes at all.
			await fs.rename(real, realTarget)
		}
		writeFrame(socket, { ok: true, bytesWritten: written.bytesWritten, sizeBytes })
	} catch (err) {
		writeFrame(socket, { ok: false, error: err.message })
	} finally {
		if (handle) await handle.close().catch(() => {})
		writePartsInFlight.delete(real)
	}
}

async function handleWriteFile(socket, body) {
	if (!body || !body.path) {
		writeFrame(socket, { ok: false, error: 'missing_path_or_content' })
		return
	}
	if (body.part !== undefined && body.part !== null) {
		// An array is `typeof 'object'` too, and would otherwise read as a
		// part with every field undefined — a whole-file write to `body.path`
		// under an op shape claiming to be something else. A `part` that is
		// present but is not an object is a malformed request, so it is
		// refused rather than quietly served as the other thing.
		if (typeof body.part !== 'object' || Array.isArray(body.part)) {
			writeFrame(socket, { ok: false, error: 'write_part_invalid_shape' })
			return
		}
		await handleWriteFilePart(socket, body, body.part)
		return
	}
	if (body.content === undefined) {
		writeFrame(socket, { ok: false, error: 'missing_path_or_content' })
		return
	}
	try {
		const { target, root } = resolveWritablePath(body.path)
		await fs.mkdir(path.dirname(target), { recursive: true })
		const real = await realpathWithinWorkspace(target, root)
		const buf = decodeWriteBody(body)
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

// --- stream liveness ------------------------------------------------------

// Missed intervals that end a stream, and the floor a host's requested
// interval is clamped to. Three misses so one lost frame is not fatal; the
// floor because the interval arrives from the host and a pathological value
// would have this process doing nothing but writing heartbeats. Both are
// the host's numbers too — `protocol.ts` declares them for that side.
const STREAM_HEARTBEAT_MISS_LIMIT = 3
const MIN_STREAM_HEARTBEAT_MS = 100

// Idle time before the kernel sends its first keepalive probe on an accepted
// connection, in the routed listen mode. Matches the host dial's own delay.
const TCP_KEEPALIVE_INITIAL_DELAY_MS = 15_000

/**
 * What this agent will actually use for a requested interval, or undefined
 * if the host asked for none.
 *
 * The clamped value is what goes back in `ready`, so the host arms the same
 * number this side did rather than the one it asked for.
 */
function normalizeHeartbeatMs(requested) {
	if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
		return undefined
	}
	return Math.max(MIN_STREAM_HEARTBEAT_MS, Math.floor(requested))
}

/**
 * Arm the negotiated heartbeat for one stream: send a `heartbeat` frame
 * every `intervalMs`, and call `onDead` when the host has sent nothing —
 * not a heartbeat, not a frame, not a byte — for
 * {@link STREAM_HEARTBEAT_MISS_LIMIT} of them.
 *
 * Proof of life is counted in BYTES, off the socket itself, rather than in
 * complete frames: a single large `data` frame can take longer to arrive
 * than the window, and the host was plainly still there while it arrived.
 * That is also why nothing here has to be threaded through the per-op frame
 * handlers — the listener is attached to the one socket this stream owns,
 * and removed again by `stop`.
 *
 * Only ever called with an interval the host asked for, which is the whole
 * of the compatibility story: a host that predates this never sets the
 * field, never gets a frame type it would treat as a protocol error, and
 * sees exactly the stream it always saw.
 *
 * The watchdog polls at a quarter of the interval so a dead host is noticed
 * within three intervals plus at most one tick. Both timers are unref'd, so
 * an open stream never by itself keeps this process alive.
 */
function armStreamHeartbeat(socket, intervalMs, onDead) {
	let stopped = false
	let watching = true
	let lastSeen = Date.now()
	// Attached while the socket is flowing — every caller arms at `ready`,
	// before any backpressure pause — so this never resumes a paused socket.
	const seen = () => {
		lastSeen = Date.now()
	}
	socket.on('data', seen)
	const send = setInterval(() => {
		if (stopped) return
		if (socket.destroyed || socket.writableEnded) return
		writeFrame(socket, { type: 'heartbeat' })
	}, intervalMs)
	const watch = setInterval(
		() => {
			if (stopped || !watching) return
			if (Date.now() - lastSeen < intervalMs * STREAM_HEARTBEAT_MISS_LIMIT) return
			stop()
			onDead()
		},
		Math.max(10, Math.floor(intervalMs / 4)),
	)
	if (typeof send.unref === 'function') send.unref()
	if (typeof watch.unref === 'function') watch.unref()
	function stop() {
		stopped = true
		socket.off('data', seen)
		clearInterval(send)
		clearInterval(watch)
	}
	return {
		/**
		 * This side paused reading for backpressure, so silence is its own
		 * doing: the host's frames are sitting in the kernel, unread.
		 */
		suspend() {
			watching = false
		},
		resume() {
			if (stopped) return
			watching = true
			lastSeen = Date.now()
		},
		stop,
	}
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
	// Undefined unless the host asked for one in the open body — see
	// `armStreamHeartbeat`.
	const heartbeatMs = normalizeHeartbeatMs(body?.heartbeatMs)
	let heartbeat

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
		if (event.type === 'heartbeat') return
		if (event.type === 'input') {
			if (
				typeof event.data === 'string' &&
				child?.stdin?.writable &&
				!child.stdin.write(event.data)
			) {
				socket.pause()
				// Nothing is read while this is paused, so the watchdog must
				// not read that as the host having gone away.
				heartbeat?.suspend()
				child.stdin.once('drain', () => {
					if (!settled) socket.resume()
					heartbeat?.resume()
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
			heartbeat?.stop()
			writeFrame(socket, { type: 'error', error: error.message })
			socket.end()
		})
		child.once('close', (exitCode, signal) => {
			if (settled) return
			settled = true
			heartbeat?.stop()
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
		// The echo is what arms the host, and it carries the CLAMPED value so
		// both sides count the same interval. A host that asked for nothing
		// gets the same bare `ready` it always got.
		writeFrame(socket, { type: 'ready', ...(heartbeatMs !== undefined ? { heartbeatMs } : {}) })
		if (heartbeatMs !== undefined) {
			// Destroying the socket runs `onClose` below, which is the same
			// cleanup a host that simply went away already triggers.
			heartbeat = armStreamHeartbeat(socket, heartbeatMs, () => socket.destroy())
		}
		for (const event of pending.splice(0)) apply(event)
	}

	void start().catch((error) => {
		if (settled) return
		heartbeat?.stop()
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
			heartbeat?.stop()
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
	// Undefined unless the host asked for one — see `armStreamHeartbeat`.
	const heartbeatMs = normalizeHeartbeatMs(body?.heartbeatMs)
	let heartbeat
	const upstream = net.createConnection({ host, port })
	const finish = (event) => {
		if (settled) return
		settled = true
		heartbeat?.stop()
		if (event) writeFrame(socket, event)
		upstream.destroy()
		socket.end()
	}

	upstream.once('connect', () => {
		// The echo carries the CLAMPED interval, and arms the host; a host
		// that asked for nothing gets the same bare `ready` it always got.
		writeFrame(socket, { type: 'ready', ...(heartbeatMs !== undefined ? { heartbeatMs } : {}) })
		if (heartbeatMs !== undefined) {
			// Destroying the socket runs `onClose` below — the same cleanup a
			// host that simply went away already triggers.
			heartbeat = armStreamHeartbeat(socket, heartbeatMs, () => socket.destroy())
		}
	})
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
					// Nothing is read while this is paused, so the watchdog must
					// not read that as the host having gone away.
					heartbeat?.suspend()
					upstream.once('drain', () => {
						if (!settled) socket.resume()
						heartbeat?.resume()
					})
				}
				return
			}
			if (event?.type === 'heartbeat') return
			if (event?.type === 'end') {
				upstream.end()
				return
			}
			if (event?.type === 'destroy') finish()
		},
		onClose() {
			settled = true
			heartbeat?.stop()
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
			// Additive and version-neutral: a host that has never heard of
			// `features` reads exactly the reply it always read. See
			// {@link AGENT_FEATURES}.
			features: AGENT_FEATURES,
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
	if (agentRetiring && op === 'attach-execution') {
		// Every other op is refused with the request-shaped reply below. An
		// attach's caller is reading a STREAM, so a fenced agent answers it
		// in the stream's own refusal shape — `{type:'error'}` and the
		// terminator — rather than with a frame that peer has no grammar
		// for and can only report as a protocol violation.
		writeFrame(socket, { type: 'error', error: 'agent_retiring' })
		writeTerminator(socket)
		socket.end()
		return
	}
	if (agentRetiring) {
		writeFrame(socket, { ok: false, error: 'agent_retiring' })
		socket.end()
		return
	}
	if (op === 'reserve-execution') {
		handleReserveExecution(socket, req.body)
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
	if (op === 'attach-execution') {
		return handleAttachExecution(socket, req.body)
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
		server = net.createServer()
		if (listenMode === 'tcp') {
			// SO_KEEPALIVE on the ROUTED listener only. The unix and vsock
			// modes are host-local and have no middlebox to lose state in;
			// setting it there would be a change to the Firecracker tier for
			// no gain. Registered BEFORE the handler, so a connection that
			// `handleConnection` refuses on its first frame has still had it
			// applied. It proves only that the peer's kernel answers — the
			// negotiated stream heartbeat is what proves its event loop does.
			server.on('connection', (socket) => {
				try {
					socket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS)
				} catch {}
			})
		}
		server.on('connection', handleConnection)
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
	AGENT_FEATURES,
	FIRECRACKER_AGENT_PROTOCOL_VERSION,
	MAX_TIMEOUT_MS,
	OutputLog,
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
