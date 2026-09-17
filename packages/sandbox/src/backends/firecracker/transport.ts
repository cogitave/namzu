/**
 * Host-side vsock transport + dialer for the Firecracker in-VM agent.
 *
 * This is the NEW code the §2.2 decision calls for. The docker/ACI
 * backends reach the agent over HTTP with `fetch`; **Node `fetch`
 * cannot dial `AF_VSOCK`**, and across an FC snapshot resume a TCP
 * control channel is dead-on-arrival (FC `snapshot-support.md`: TCP
 * connection state does not survive a resume; the **vsock LISTEN
 * socket** does). So the FC control channel is a framed stream over
 * vsock, and that framing + the resume-survival hardening live here.
 *
 * ## One wire, two transports
 * The message FORMAT (NDJSON exec events + base64 file-IO) is shared
 * with the HTTP backends via `protocol.ts`. This module owns only the
 * TRANSPORT: how a request crosses the wire and how a response is
 * framed back.
 *
 * Framing: a length-prefixed envelope per message —
 *   `<8-hex-digit big-endian byte length>\n<utf8 JSON payload>`
 * The newline after the hex length lets a reader find the boundary
 * without a fixed header struct, and the explicit length means a
 * payload that itself contains newlines (NDJSON exec output) is read
 * whole, not split. Exec replies are a SEQUENCE of framed NDJSON
 * lines terminated by a zero-length frame; file-IO replies are a
 * single framed JSON object.
 *
 * ## How vsock is actually dialed from Node
 * Node has no `AF_VSOCK` socket family. The production path therefore
 * follows exactly what the in-situ bench already proved: the guest
 * agent's vsock stream is bridged to a **host-side unix-domain
 * socket** (the bench relays guest `AF_VSOCK` → host CID:port → a host
 * unix socket; FC's own vsock device exposes a host-side unix socket
 * rendezvous, `UDS + "CONNECT <port>"`). So the host dialer ALWAYS
 * terminates on a `net.connect({ path })` unix socket:
 *   - `kind: 'unix'`   — connect directly to `path` (local/dev + tests).
 *   - `kind: 'vsock'`  — connect to the FC vsock device's host unix
 *     socket `udsPath`, then send the firecracker hybrid-vsock
 *     handshake line `CONNECT <port>\n` and await the `OK <hostport>`
 *     ack before framing application traffic.
 * Both land on the same `net.Socket`, so the unix-socket stand-in in
 * the tests exercises the identical framing/heartbeat/reconnect code
 * the vsock path runs — the only delta is the one-line CONNECT
 * handshake, which is covered by its own assertion.
 *
 * ## Resume survival (the hard invariant, FC #4713 / loopholelabs)
 * On resume the guest vsock driver closes all existing connections and
 * the `TRANSPORT_RESET` event may NOT be delivered, so a host read can
 * hang. The agent re-LISTENs after every resume; the host dialer
 * carries a per-attempt connect/handshake **timeout + retry budget**
 * so a dropped reset cannot wedge first-exec — the dialer simply
 * re-dials. Every request opens a fresh connection (no long-lived
 * socket to be silently severed by a resume), which makes the
 * transport resume-survivable by construction.
 */

import { randomUUID } from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'

import type {
	OpenTerminalOptions,
	SandboxExecOptions,
	SandboxExecResult,
	SandboxReadFileOptions,
	SandboxTcpConnectOptions,
	SandboxTcpConnection,
	TerminalSession,
} from '@namzu/sdk'
import { OperationDeadline, OperationDeadlineExpired } from '../readiness.js'
import {
	REMOTE_EXECUTION_PROTOCOL_VERSION,
	RemoteCancellationUnknownError,
	type RemoteExecutionAdapter,
	RemoteExecutionController,
	RemoteProtocolError,
} from '../remote-execution-controller.js'
import {
	type AgentRequestCredential,
	type AttachSessionRequest,
	type ExecRequest,
	ExecResultAccumulator,
	type FlushRequest,
	type GuestReplyIdentity,
	type KillSessionRequest,
	MIN_STREAM_HEARTBEAT_MS,
	type QuiesceRequest,
	READ_FILE_STREAM_FEATURE,
	type ReadFileRequest,
	type ReadFileResponse,
	type ReadFileStreamEvent,
	type ReadFileStreamRequest,
	STREAM_HEARTBEAT_MAX_ECHO_FACTOR,
	STREAM_HEARTBEAT_MISS_LIMIT,
	type StartDetachedRequest,
	type TcpConnectRequest,
	type TcpInputEvent,
	type TcpOutputEvent,
	type TerminalInputEvent,
	type TerminalOpenRequest,
	type TerminalOutputEvent,
	type TerminalReadyEvent,
	WRITE_FILE_PARTS_FEATURE,
	type WriteFileRequest,
	type WriteFileResponse,
	parseExecLine,
} from './protocol.js'

// ---------------------------------------------------------------------------
// Handle — how a single sandbox's agent is addressed
// ---------------------------------------------------------------------------

/**
 * An addressable agent endpoint. The orchestrator hands one of these
 * back per sandbox (`create()` response → `vsock endpoint`).
 *
 *  - `unix`  — a host unix-domain socket the agent (or a relay) is
 *    listening on. The local/dev path and the test stand-in.
 *  - `vsock` — a Firecracker hybrid-vsock device exposed as a host
 *    unix socket at `udsPath`; `port` is the guest AF_VSOCK port the
 *    agent listens on (the fixed contract port baked into the golden
 *    rootfs). The dialer connects to `udsPath` then issues the
 *    `CONNECT <port>` handshake.
 *  - `mtls`  — a per-FC-host mTLS RELAY daemon reachable over the
 *    network at `host:port` (the owning host's private VNet IP + the
 *    bridge port). The dialer `tls.connect`s the relay presenting the
 *    fleet client cert, verifies the relay's server cert
 *    (`rejectUnauthorized: true`), then writes a single routing
 *    preamble line `SANDBOX <sandboxId>\n`. The relay terminates mTLS,
 *    resolves `sandboxId` to the host-local jailed `v.sock`, dials it,
 *    and issues the guest `CONNECT 1024` handshake ITSELF — so the
 *    caller does NOT write the `CONNECT` line. After the preamble the
 *    relay is a verbatim byte pump, so the IDENTICAL 8-hex/NDJSON
 *    framing + heartbeat + retry runs unchanged over the TLS socket
 *    (`tls.TLSSocket` is a `net.Socket`). The container-app NEVER sees
 *    a host-local `udsPath`; the cert material is injected by the
 *    Vandal host layer, never returned by the orchestrator.
 *  - `tcp`   — the guest agent listening directly on a routed pod
 *    network (the kubernetes backend). The dialer does a plain
 *    `net.connect({ host, port })` — no relay, no routing preamble, no
 *    ack: there is nothing between the host and the guest's own listen
 *    socket to route through, so the framing loop starts on the very
 *    first byte, exactly as the `unix` arm's does. `host` may be a
 *    Service FQDN rather than a literal IP; every call dials fresh (see
 *    `dial()` below), so DNS is re-resolved on every request and a
 *    resumed pod's new address is picked up for free. `token` rides in
 *    each request envelope (see `AgentRequestCredential` in
 *    `protocol.ts`) because a routed listener authenticates what the
 *    vsock/unix control channel never had to.
 */
export type SandboxAgentHandle =
	| { readonly kind: 'unix'; readonly path: string }
	| { readonly kind: 'vsock'; readonly udsPath: string; readonly port: number }
	| {
			readonly kind: 'mtls'
			readonly host: string
			readonly port: number
			readonly sandboxId: string
			readonly tls: {
				readonly ca: string | Buffer
				readonly cert: string | Buffer
				readonly key: string | Buffer
				readonly servername?: string
			}
	  }
	| { readonly kind: 'tcp'; readonly host: string; readonly port: number; readonly token?: string }

/**
 * The mTLS cert material the consumer injects onto a wire `mtls` handle (the
 * `tls` block of the transport handle). Read from the consumer's runtime (the
 * Vandal host layer's `VANDAL_SANDBOX_FC_TLS_*`), NEVER returned by the
 * orchestrator — the leak-prevention boundary.
 */
export interface MtlsClientMaterial {
	readonly ca: string | Buffer
	readonly cert: string | Buffer
	readonly key: string | Buffer
	readonly servername?: string
}

/**
 * The WIRE shape of an agent handle as the FIRECRACKER orchestrator
 * returns it. Identical to {@link SandboxAgentHandle} EXCEPT the `mtls`
 * arm omits the `tls` cert block: the orchestrator returns only
 * host/port/sandboxId, and the consumer (Vandal host layer) merges the
 * cert material in (see `normalizeHandle`) before constructing the
 * transport. The `unix`/`vsock` arms are unchanged (they carry no cert
 * material). There is deliberately no `tcp` arm here: that kind belongs
 * to the kubernetes backend, which builds its {@link SandboxAgentHandle}
 * directly (host/port from the claimed Sandbox's status, token from the
 * pod's own identity) and never goes through this orchestrator wire
 * shape or `normalizeHandle`.
 */
export type WireSandboxAgentHandle =
	| { readonly kind: 'unix'; readonly path: string }
	| { readonly kind: 'vsock'; readonly udsPath: string; readonly port: number }
	| {
			readonly kind: 'mtls'
			readonly host: string
			readonly port: number
			readonly sandboxId: string
	  }

// ---------------------------------------------------------------------------
// Request envelope — the one method dimension on top of the shared wire
// ---------------------------------------------------------------------------

/**
 * A framed request. `op` selects the agent handler; the HTTP worker
 * used the URL path (`/execute`, `/read-file`, `/write-file`,
 * `/healthz`) — over vsock the same selector rides in the framed JSON.
 */
export type AgentRequest = (
	| { readonly op: 'execute'; readonly body: ExecRequest }
	// `body` is optional and additive: the reservation the shared execution
	// controller sends carries none and is byte-for-byte what it always
	// was, while a caller that owns its own execution ids names one here.
	| {
			readonly op: 'reserve-execution'
			readonly body?: { readonly executionId: string }
	  }
	| {
			readonly op: 'cancel-execution'
			readonly body: { readonly executionId: string }
	  }
	| {
			readonly op: 'attach-execution'
			readonly body: { readonly executionId: string; readonly fromOffset?: number }
	  }
	| { readonly op: 'read-file'; readonly body: ReadFileRequest }
	| { readonly op: 'read-file-stream'; readonly body: ReadFileStreamRequest }
	| { readonly op: 'write-file'; readonly body: WriteFileRequest }
	| { readonly op: 'terminal'; readonly body: TerminalOpenRequest }
	// The four session ops. Every one of them is additive and every one is
	// sent only to a guest that advertised `sessions` in its `healthz`
	// features — see {@link SESSIONS_FEATURE}.
	| { readonly op: 'attach-session'; readonly body: AttachSessionRequest }
	| { readonly op: 'start-detached'; readonly body: StartDetachedRequest }
	| { readonly op: 'list-sessions' }
	| { readonly op: 'kill-session'; readonly body: KillSessionRequest }
	| { readonly op: 'tcp-connect'; readonly body: TcpConnectRequest }
	| { readonly op: 'quiesce'; readonly body: QuiesceRequest }
	// Additive in exactly the way `quiesce` is, and sent only to a guest
	// whose `healthz` named {@link FLUSH_FEATURE}.
	| { readonly op: 'flush'; readonly body: FlushRequest }
	| { readonly op: 'healthz' }
) &
	// Intersected, not repeated per arm: the credential is orthogonal to
	// the op, and every arm may carry it. Optional and additive, so a host
	// that writes no token speaks the wire it always did — see
	// {@link AgentRequestCredential}.
	AgentRequestCredential

/**
 * One `exec()` call's wall-time breakdown on the Firecracker tier.
 *
 * The first four fields are the same four the kubernetes tier reports
 * through `KubernetesTransportTiming` — this backend is the transport that
 * tier WRAPS, so the phases are the same phases and deliberately carry the
 * same names and the same meanings. The last three are what only this tier
 * can see, because only this tier owns the socket that carries the execute
 * round trip: the first reply frame, the zero-length terminator frame the
 * guest writes when the command's process group is done, and the peer's own
 * close after it.
 *
 * Durations are NOT a partition of a single total — `reserveMs` and
 * `executeMs` each include their OWN dial, which is also folded into
 * `dialMs`, and the three execute sub-phases are intervals INSIDE
 * `executeMs`, all three measured from the moment the execute request was
 * written to the socket. This is a diagnostic breakdown for attribution, not
 * an accounting identity.
 *
 * The three sub-phases are ABSENT when the phase was never reached (a call
 * that failed at the dial, or a stream that ended without a terminator),
 * which is a different fact from a phase that measured 0 ms.
 *
 * Never carries a token, a command, its arguments, or any output.
 */
export interface FirecrackerTransportTiming {
	/**
	 * Total time spent establishing connections for this call.
	 *
	 * Counts ESTABLISHED connections only: a dial that never connected adds
	 * nothing here, exactly as it never fires
	 * {@link VsockTransportOptions.onDial}. The time such an attempt spent is
	 * inside the phase that asked for the connection (`reserveMs`,
	 * `executeMs`), and "a connection was never made" is what
	 * {@link VsockTransportOptions.onDialAttempt} paired with `onDial` says —
	 * not something this number can express.
	 */
	readonly dialMs: number
	/** Time spent on the `reserve-execution` round trip (dial included). */
	readonly reserveMs: number
	/** Time spent on the `execute` round trip (dial included). */
	readonly executeMs: number
	/**
	 * Time between the execute round trip settling and `exec()` itself
	 * resolving — this transport's own post-execute bookkeeping (clearing
	 * timers, tearing down the observation race). Always small on the happy
	 * path; distinct from `executeMs` because it is spent locally, after the
	 * peer has nothing left to do.
	 */
	readonly drainMs: number
	/**
	 * Request written → the guest FIRST SPOKE. The guest agent writes
	 * nothing until the command it spawned produces output or ends, so this
	 * interval carries the spawn and startup of the command plus whatever
	 * the guest does before that — and for a command that prints NOTHING it
	 * carries the command's whole runtime, because the first frame the host
	 * sees is then the terminal one. Read it against a command that talks
	 * early (`sh -c 'echo ok'`): the spawn latency lands here, and a wait on
	 * the guest's side before the command starts moves this number without
	 * moving `terminatorMs`' interval past it.
	 */
	readonly firstFrameMs?: number
	/**
	 * Request written → the zero-length terminator frame, which the guest
	 * writes when the command's process group is done and its output is
	 * flushed. The number that separates a cost the command paid from a cost
	 * the path paid is THIS interval minus `firstFrameMs` — the time the
	 * guest went on for after it first spoke. That is a fact about a command
	 * that produced output near its start; for a silent command the two
	 * intervals are nearly equal and both carry the runtime.
	 */
	readonly terminatorMs?: number
	/**
	 * Terminator seen → the peer's socket close — the peer's OWN close, and
	 * never one this transport caused itself. Time a relay in front of the
	 * guest spends holding the FIN (buffering it, or waiting for its own idle
	 * timer) lands here and nowhere else in this object, for as long as it
	 * lands UNDER {@link POST_RESPONSE_CLOSE_TIMEOUT_MS}.
	 *
	 * A hold at or past that bound does not appear here at all, and the field
	 * is ABSENT from the report: the call rejects on the guard, and a constant
	 * this transport chose is not a duration the peer took. A host diagnosing
	 * a slow close therefore reads this field when the call resolved, and the
	 * named rejection when it did not.
	 */
	readonly peerCloseMs?: number
}

export interface VsockTransportOptions {
	/** Per-attempt connect + handshake timeout. Default 5000ms. */
	readonly connectTimeoutMs?: number
	/** Total time budget for connect retries (resume survival). Default 30000ms. */
	readonly connectRetryBudgetMs?: number
	/** Backoff between connect retries. Default 100ms. */
	readonly connectRetryIntervalMs?: number
	/**
	 * Idle read timeout once connected and the request is sent. Guards
	 * the FC #4713 "read hangs because TRANSPORT_RESET was not
	 * delivered" case: if no byte arrives within this window the
	 * transport tears the socket down and the caller's retry re-dials
	 * against the agent's fresh listen socket. Default 60000ms.
	 */
	readonly readIdleTimeoutMs?: number
	/**
	 * Interval, in milliseconds, of the per-stream liveness heartbeat on
	 * `openTerminal` and `openTcpConnection`. See `protocol.ts`'s
	 * `StreamHeartbeat` for the negotiation and what a heartbeat does and
	 * does not prove.
	 *
	 * **Undefined by default, and deliberately so.** This transport is
	 * shared with the Firecracker tier, where a default would force-close an
	 * existing consumer's quiet-but-alive terminal after three intervals —
	 * a changed default for a tier that asked for nothing. The Kubernetes
	 * backend opts in (`backends/kubernetes/index.ts`'s
	 * `DEFAULT_STREAM_HEARTBEAT_MS`); every other caller that passes nothing
	 * sends and expects exactly the frames it always did.
	 *
	 * A value of `0` or less is the same as leaving it out.
	 */
	readonly heartbeatMs?: number
	/**
	 * Fires once per successful dial with how long the connect took, in
	 * milliseconds. Never fires with the handle's `token` or any request
	 * content — a bare number. Used by callers that build their own
	 * `RemoteExecutionAdapter` on top of this transport (the kubernetes
	 * backend's `KubernetesAgentTransport`) to attribute wall time; the
	 * vsock/mtls/unix arms are free to ignore it.
	 */
	readonly onDial?: (durationMs: number) => void
	/**
	 * Fires once per connect ATTEMPT, immediately before it is made, and
	 * carries nothing at all.
	 *
	 * {@link onDial} above only ever fires for an attempt that SUCCEEDED, and
	 * a caller that has to know a socket was never established cannot learn
	 * it from the attempt's error either: an attempt can be aborted — by its
	 * caller, or by a deadline shorter than {@link connectTimeoutMs} — before
	 * it has failed, and the abort is what the caller is then holding. Paired
	 * with `onDial`, this says "a dial was attempted and none of them handed
	 * back a socket", which on the `tcp` arm is exactly "nothing reached the
	 * guest": that arm resolves only on the socket's own `connect` event, so
	 * no byte can have been sent before `onDial` fired.
	 *
	 * Used by the kubernetes backend's `KubernetesAgentTransport` to decide
	 * whether a failed `exec()` may be retried against a replaced pod. The
	 * vsock/mtls/unix arms are free to ignore it.
	 */
	readonly onDialAttempt?: () => void
	/**
	 * Fires once per completed `exec()` (and {@link VsockAgentTransport.execute})
	 * call — success or failure — with that call's wall-time breakdown, so a
	 * host can attribute an exec's wall clock to a phase without patching this
	 * package. The payload is exactly the numbers described on
	 * {@link FirecrackerTransportTiming}: never the token, a command, its
	 * arguments, or any output. An OBSERVER, like every other hook on these
	 * options: it cannot change the call's result, it is called after the
	 * call has settled, and a listener that throws is the listener's problem.
	 *
	 * Named `onExecTiming` rather than `onTiming` because these options are
	 * the BASE of `KubernetesTransportOptions`, which already spends the name
	 * `onTiming` on a payload of its own; one name for two different payloads
	 * on two transports is the kind of footgun this package refuses
	 * elsewhere. A consequence worth stating plainly: a wire belonging to the
	 * kubernetes tier INHERITS this field and never fires it, because that
	 * tier builds its own adapter and drives the shared transport through
	 * {@link VsockAgentTransport.executeStreamed}, not through `exec()`.
	 *
	 * Absent by default, and a host that sets nothing pays nothing: the
	 * ledger that carries these numbers is created only when this hook is
	 * set, and the same check that skips creating it skips every measurement
	 * that would have filled it.
	 */
	readonly onExecTiming?: (timing: FirecrackerTransportTiming) => void
	/**
	 * Fires once for every reply this transport reads that the guest
	 * answered on an AUTHENTICATED basis — one control/file reply per
	 * `request`, and the opening `ready` frame of a terminal, a session
	 * attachment or a TCP stream.
	 *
	 * It carries the reply itself, read only for the optional identity
	 * fields `protocol.ts` documents ({@link GUEST_BOOT_ID_FEATURE}), and it
	 * is an OBSERVER: it cannot change the reply, it is called after the
	 * reply has been accepted, and a listener that throws is that listener's
	 * problem — never the caller's, whose result is already decided.
	 *
	 * Absent by default, which is what keeps this shared transport's
	 * behaviour identical for the Firecracker tier. The kubernetes backend
	 * sets it to follow the guest PROCESS behind a handle whose pod uid — its
	 * bind token — cannot change when the container is restarted in place.
	 */
	readonly onGuestReply?: (reply: GuestReplyIdentity) => void
	/**
	 * The largest `writeFile` body this transport will accept, in raw
	 * bytes. Default {@link DEFAULT_MAX_WRITE_FILE_BYTES} (1 GiB).
	 *
	 * A body above one frame is written in parts (see
	 * {@link VsockAgentTransport.writeFile}), so nothing about the wire
	 * stops a caller handing over a body larger than the guest's disk or
	 * this process's heap. This is the bound that says no first, by a
	 * number the caller chose, with {@link AgentWriteFileTooLargeError}
	 * naming it — rather than by an out-of-memory or an ENOSPC halfway
	 * through a sequence of parts.
	 *
	 * Checked before the route is chosen, so it caps EVERY body — a value
	 * set below what one frame carries caps the small single-frame writes
	 * too, which is the range a host capping what a caller may push into a
	 * workspace would most plausibly set it to.
	 */
	readonly maxWriteFileBytes?: number
	/**
	 * Raw bytes per part when a `writeFile` body is written in parts.
	 * Defaults to the largest part one frame can carry, and is clamped
	 * DOWN to that: a value above what a frame admits is not a way to
	 * send a bigger frame.
	 *
	 * Setting it also lowers the size at which a body is split at all,
	 * so a suite can exercise a multi-part write without allocating one.
	 * Leave it unset in production: the default is the fewest round trips
	 * the pre-auth ceiling allows.
	 */
	readonly writeFilePartBytes?: number
	/**
	 * Say that a failed connect attempt will NOT fix itself, so the retry
	 * budget above is not worth spending on it.
	 *
	 * Absent by default, which keeps every dial retrying for the whole budget
	 * exactly as it always has — the budget exists because the common connect
	 * failure IS transient (an agent re-listening after a resume answers
	 * `ECONNREFUSED` for a moment). The exception is a failure that is about
	 * the CALLER's own environment rather than the guest's: the kubernetes
	 * backend's Service FQDN does not resolve on a host with no cluster DNS,
	 * and re-asking the same resolver the same question for half a minute
	 * only ensures the caller's own deadline expires first and reports a
	 * timeout in place of the diagnosis.
	 *
	 * Called with each attempt's error, before the backoff. Returning true
	 * ends the loop; the error thrown is the same wrapper as an exhausted
	 * budget, carrying that attempt's failure as its `cause`.
	 */
	readonly permanentDialFailure?: (error: unknown) => boolean
}

/**
 * The per-call accumulator behind {@link VsockTransportOptions.onExecTiming}.
 *
 * One instance per `exec()`/`execute()` call, closed over by that call's
 * adapter and threaded into the dial and the execute round trip the adapter
 * wraps — never a field on the transport, so two concurrent `exec()` calls
 * on one transport cannot race on the same accumulator. That is the same
 * reason the kubernetes tier builds its adapter per call rather than once.
 *
 * Every field is a millisecond duration except `executeSettledAt`, which is
 * a `Date.now()` stamp the drain interval is measured back from, and `0`
 * meaning "the execute round trip never settled".
 */
interface ExecTimingLedger {
	dialMs: number
	reserveMs: number
	executeMs: number
	executeSettledAt: number
	firstFrameMs?: number
	terminatorMs?: number
	peerCloseMs?: number
}

/** The reportable view of a ledger — see {@link FirecrackerTransportTiming}. */
function timingOf(ledger: ExecTimingLedger): FirecrackerTransportTiming {
	return {
		dialMs: ledger.dialMs,
		reserveMs: ledger.reserveMs,
		executeMs: ledger.executeMs,
		drainMs: ledger.executeSettledAt > 0 ? Date.now() - ledger.executeSettledAt : 0,
		// Spread conditionally, not set to a sentinel: "this phase was never
		// reached" and "this phase took no measurable time" are different
		// statements, and only an absent field says the first.
		...(ledger.firstFrameMs !== undefined ? { firstFrameMs: ledger.firstFrameMs } : {}),
		...(ledger.terminatorMs !== undefined ? { terminatorMs: ledger.terminatorMs } : {}),
		...(ledger.peerCloseMs !== undefined ? { peerCloseMs: ledger.peerCloseMs } : {}),
	}
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_CONNECT_RETRY_BUDGET_MS = 30_000
const DEFAULT_CONNECT_RETRY_INTERVAL_MS = 100
const DEFAULT_READ_IDLE_TIMEOUT_MS = 60_000
const DEFAULT_EXECUTION_TIMEOUT_MS = 5 * 60_000
// The ownership controller begins reconciliation shortly after the requested
// command timeout. The data socket itself stays observable for the peer's
// bounded TERM -> KILL confirmation window so a quiet but correctly
// terminating command can still deliver its terminal frame and output tail.
const EXECUTION_TRANSPORT_GRACE_MS = 10_000
/**
 * How long a reply that has already TERMINATED waits for the peer's own close
 * before this transport gives up on it. Three callers, all of them read-reply
 * loops that resolve on that close: {@link VsockAgentTransport.request} (one
 * control or file reply), {@link VsockAgentTransport.executeRaw} (an exec's
 * zero-length terminator frame) and `streamFramedRequest` (a
 * `read-file-stream`'s end frame).
 *
 * **A reject-only guard, and deliberately not a budget to spend.** It can
 * only turn a socket whose peer never closes into a named failure
 * (`exec peer did not close after terminator`, or the `stream`/`control`
 * wordings); it can never resolve a call, because every resolution path in
 * this file requires the peer's `close` event. Raising it therefore buys no
 * slow success — it delays a diagnosis — and lowering it fails a peer that
 * was merely slow to close. It is not a wait any caller is expected to pay:
 * a call that resolves has paid a real close, and how long the peer took to
 * deliver it is reported as
 * {@link FirecrackerTransportTiming.peerCloseMs}.
 *
 * **The contract this states for a host-owned relay.** After writing the
 * terminator frame the agent calls `socket.end()` — a half-close — and this
 * transport resolves the call on the resulting `close`. A relay between the
 * guest and this process that forwards the payload but holds the FIN (its
 * own idle timer, a full-duplex buffering policy, a proxy that waits for the
 * guest process to exit) transfers that wait onto every call: under this
 * bound it is reported as `peerCloseMs`, and at or past it the call REJECTS
 * by name, with no `peerCloseMs` in the report — the number a host would
 * otherwise be reading is one this transport chose, and it does not supply
 * it. A relay that forwards the FIN promptly costs the guest's RTT and
 * nothing else.
 */
const POST_RESPONSE_CLOSE_TIMEOUT_MS = 1_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * The guest agent's default pre-auth frame ceiling for a routed (`tcp`)
 * connection — mirrors `agent.cjs`'s `MAX_PREAUTH_FRAME_BYTES`
 * (`NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES`, default 8 MiB). The gate on
 * that side cannot run until a whole frame is parsed (the credential
 * rides inside the envelope), so it bounds what an UNAUTHENTICATED
 * connection's first frame may announce. This transport dials fresh per
 * call — there is no persistent, already-authenticated connection to
 * reuse — so EVERY `tcp` request is that connection's first frame, and
 * this ceiling is therefore the effective per-request budget, not just
 * a one-time cost paid on first use.
 *
 * Checked here, client-side, BEFORE dialing: an oversized request fails
 * fast with a clear error instead of opening a connection the guest is
 * going to refuse anyway. Chunking a `write-file` body across multiple
 * frames would lift this ceiling; it is a documented follow-up, not
 * implemented by this transport.
 */
export const TCP_PREAUTH_FRAME_LIMIT_BYTES = 8 * 1024 * 1024

/**
 * The guest agent's default ceiling on ANY frame, pre-auth or not —
 * mirrors `agent.cjs`'s `MAX_FRAME_BYTES` (`NAMZU_AGENT_MAX_FRAME_BYTES`,
 * default 256 MiB). It is the budget the `unix`/`vsock`/`mtls` arms are
 * bounded by, since none of them runs a credential gate and so none of
 * them ever pays the smaller pre-auth price.
 */
export const GUEST_FRAME_LIMIT_BYTES = 256 * 1024 * 1024

/** Default {@link VsockTransportOptions.maxWriteFileBytes} — 1 GiB. */
export const DEFAULT_MAX_WRITE_FILE_BYTES = 1024 * 1024 * 1024

/**
 * Idle time before the kernel sends its first TCP keepalive probe on a
 * `tcp`-arm connection, host side. 15 s, matching the Kubernetes backend's
 * default heartbeat interval, so the two bounds do not disagree about how
 * long a silent connection is allowed to look healthy.
 */
export const TCP_KEEPALIVE_INITIAL_DELAY_MS = 15_000

/**
 * Slack subtracted from a frame budget when sizing a part, over and above
 * the envelope this transport measures exactly. The guest's own accounting
 * is of the framed payload, and a deployment is free to configure a
 * slightly different ceiling than the default this side assumes; a
 * kilobyte of headroom costs one part in a thousand and removes a whole
 * class of off-by-a-few refusals.
 */
const WRITE_FILE_PART_HEADROOM_BYTES = 1024

/**
 * How long the best-effort removal of an abandoned part file may take.
 * Bounded separately from the connect retry budget because it runs AFTER
 * the caller's write has already failed — often because the peer is gone —
 * and a caller waiting on a rejection should not wait out a retry budget
 * for a cleanup whose failure it is never told about.
 */
const WRITE_FILE_DISCARD_TIMEOUT_MS = 5_000

/**
 * Thrown when a `tcp`-handle request's framed envelope (op + body +
 * token) would exceed {@link TCP_PREAUTH_FRAME_LIMIT_BYTES}. Named so a
 * caller can distinguish "this body needs chunking" from every other
 * transport failure.
 */
export class AgentPreauthFrameTooLargeError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'AgentPreauthFrameTooLargeError'
	}
}

/**
 * Thrown when a `writeFile` body exceeds
 * {@link VsockTransportOptions.maxWriteFileBytes}. Distinct from
 * {@link AgentPreauthFrameTooLargeError}: that one says the WIRE cannot
 * carry this in one frame (and, since the part protocol, only ever fires
 * when the guest cannot carry it in several either), this one says the
 * HOST was configured not to send a body this large at all.
 */
export class AgentWriteFileTooLargeError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'AgentWriteFileTooLargeError'
	}
}

/**
 * Thrown when a read this transport cannot serve on the old whole-file op
 * is asked of a guest that does not advertise
 * {@link READ_FILE_STREAM_FEATURE} — a ranged `readFile`, or any
 * `readFileStream`.
 *
 * A refusal rather than a fallback, and that is the whole point of the
 * class: an agent that predates the feature IGNORES `offset`/`length` and
 * answers with the WHOLE file, so silently taking the old path would hand
 * a caller the entire file where it asked for a slice — a wrong answer
 * dressed as a degraded one. Named so a host can tell "rebuild the guest
 * image" apart from "that file is not there".
 */
export class AgentReadFileStreamUnsupportedError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'AgentReadFileStreamUnsupportedError'
	}
}

/**
 * How many bytes of a `read-file-stream` may sit decoded on this side
 * while the consumer is slow, before the socket is paused.
 *
 * The bound exists because an `AsyncIterable` consumer pulls: without it a
 * fast guest would fill the host's heap with exactly the whole file this
 * op exists to avoid materialising. One chunk is the guest's own
 * `NAMZU_AGENT_READ_FILE_STREAM_CHUNK_BYTES` (256 KiB by default), so this
 * is a few chunks in flight and nothing like a file. A deployment that
 * raises that variable raises the number of BYTES held here, not the
 * number of chunks: this is a byte bound, so it keeps holding.
 *
 * Deliberately not derived from the guest's value. The guest is a
 * different process on a different release train, this side has to bound
 * its own heap before it has asked the guest anything, and a host that
 * trusted a guest-supplied chunk size for its own bound would have no
 * bound at all.
 */
const READ_FILE_STREAM_HIGH_WATER_BYTES = 4 * 1024 * 1024

/**
 * Thrown by {@link VsockAgentTransport}'s dial when it gives up without a
 * socket — the retry budget spent, or the failure declared one waiting cannot
 * cure. The underlying connect failure is its `cause`.
 *
 * A class, and not only a phrase in the message, because callers classify on
 * it: "the failure came out of the dial" means NOTHING was sent to the guest,
 * which is what makes a retry against a replaced pod safe (the kubernetes
 * backend's `agentAddress: 'pod-ip'` re-read). A message a guest can quote
 * back — a command's stderr, a path, a proxy's own error — cannot be allowed
 * to claim that.
 */
/**
 * The two fields that turn a connection-bound terminal into a session, on
 * the host's side of {@link VsockAgentTransport.openTerminal}.
 *
 * Both are optional and both are ignored by a guest that predates the
 * session registry, which is why the caller — never this transport — is the
 * one that checks the guest advertises the capability first.
 */
export interface SessionTerminalOpen {
	readonly sessionId?: string
	readonly persistent?: boolean
}

/**
 * One open terminal stream, plus what only a SESSION's reader needs: the
 * guest's opening frame, the byte offset to come back at, and a way to stop
 * reading without signalling the program.
 */
export interface AgentTerminalStream {
	readonly session: TerminalSession
	/** The guest's `ready` frame. Carries the session fields, when there are any. */
	readonly ready: TerminalReadyEvent
	/** One past the newest retained byte this stream has delivered, if any. */
	nextOffset(): number | undefined
	/**
	 * End this attachment locally. Nothing is signalled in the guest: the
	 * program goes on running and its output goes on filling the retained
	 * log, which is the entire difference between this and `kill`.
	 */
	detach(): void
}

/**
 * Thrown — as the rejection of a session terminal's `exited` — when the
 * attachment ended and the program did not.
 *
 * `exited` may not RESOLVE here: a resolved `exited` says the program is
 * over, and reporting `exitCode: -1` for a shell that is still running in
 * the pod is exactly the confusion this whole feature exists to remove. The
 * offset is carried because it is what the next attach resumes from.
 */
export class AgentSessionDetachedError extends Error {
	override readonly name = 'AgentSessionDetachedError'

	constructor(
		readonly nextOffset: number | undefined,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options)
	}
}

export class AgentDialFailedError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = 'AgentDialFailedError'
	}
}

/** Exact guest wire version accepted by this Firecracker transport. */
export const FIRECRACKER_AGENT_PROTOCOL_VERSION = REMOTE_EXECUTION_PROTOCOL_VERSION

/** Framing: 8 hex digits of payload byte length, then `\n`, then payload. */
const LENGTH_PREFIX_HEX = 8

function frame(payload: string): Buffer {
	const body = Buffer.from(payload, 'utf8')
	const header = Buffer.from(
		`${body.length.toString(16).padStart(LENGTH_PREFIX_HEX, '0')}\n`,
		'ascii',
	)
	return Buffer.concat([header, body])
}

/**
 * A growable accumulator that frees the buffer it grew past a threshold.
 * Sized once so both numbers are stated where they are read.
 */
const FRAME_BUFFER_INITIAL_BYTES = 64 * 1024
const FRAME_BUFFER_RETAIN_BYTES = 1024 * 1024

/**
 * Incremental frame reader. Feed it socket chunks; it yields complete
 * payloads. A zero-length frame is the exec stream terminator and is
 * surfaced as an empty string so the caller can stop.
 *
 * It accumulates into ONE buffer it grows geometrically, with a read
 * cursor, rather than re-`concat`ing every arriving chunk onto a fresh
 * allocation. The distinction only matters for a large frame, where it is
 * the difference between linear and quadratic: a `read-file` reply for a
 * 64 MiB file arrives as ~1400 socket chunks, and copying everything
 * received so far onto each one of them spent half a minute of memcpy on
 * a reply the socket delivered in under a second. Identical framing,
 * identical errors, identical `bufferedBytes` — only the copying changes.
 */
class FrameReader {
	private buf: Buffer = Buffer.alloc(0)
	/** First byte not yet handed out as part of a frame. */
	private start = 0
	/** One past the last byte received. */
	private end = 0

	push(chunk: Buffer): string[] {
		this.append(chunk)
		const out: string[] = []
		for (;;) {
			const view = this.buf.subarray(this.start, this.end)
			const nl = view.indexOf(0x0a) // '\n'
			if (nl < 0 || nl < LENGTH_PREFIX_HEX) {
				// Need at least the hex header + newline.
				if (nl >= 0 && nl < LENGTH_PREFIX_HEX) {
					throw new Error(`vsock transport: malformed frame header (newline at ${nl})`)
				}
				break
			}
			const header = view.subarray(0, nl).toString('ascii')
			if (!/^[0-9a-fA-F]{8}$/.test(header)) {
				throw new Error(`vsock transport: invalid frame length header ${JSON.stringify(header)}`)
			}
			const len = Number.parseInt(header, 16)
			if (!Number.isInteger(len) || len < 0) {
				throw new Error(`vsock transport: invalid frame length header ${JSON.stringify(header)}`)
			}
			const start = nl + 1
			if (view.length < start + len) break // incomplete payload
			out.push(view.subarray(start, start + len).toString('utf8'))
			this.consume(start + len)
		}
		return out
	}

	get bufferedBytes(): number {
		return this.end - this.start
	}

	/** Copy `chunk` in, growing (and first compacting) only when needed. */
	private append(chunk: Buffer): void {
		if (chunk.length === 0) return
		if (this.buf.length - this.end < chunk.length) {
			const needed = this.bufferedBytes + chunk.length
			if (this.buf.length >= needed) {
				// Compacting the unread bytes to the front is enough.
				this.buf.copy(this.buf, 0, this.start, this.end)
			} else {
				let capacity = this.buf.length > 0 ? this.buf.length : FRAME_BUFFER_INITIAL_BYTES
				// Geometric, so the total copying across a whole reply stays
				// proportional to its length rather than to its length squared.
				while (capacity < needed) capacity *= 2
				const grown = Buffer.allocUnsafe(capacity)
				this.buf.copy(grown, 0, this.start, this.end)
				this.buf = grown
			}
			this.end = this.bufferedBytes
			this.start = 0
		}
		chunk.copy(this.buf, this.end)
		this.end += chunk.length
	}

	/** Mark `bytes` from the read cursor as consumed. */
	private consume(bytes: number): void {
		this.start += bytes
		if (this.start !== this.end) return
		this.start = 0
		this.end = 0
		// A reply that grew the buffer to hundreds of megabytes should not
		// keep holding them for the life of a long-lived connection.
		if (this.buf.length > FRAME_BUFFER_RETAIN_BYTES) this.buf = Buffer.alloc(0)
	}
}

/**
 * The transport. One instance per sandbox handle; every request opens
 * a fresh connection (resume-survivable — no socket lingers across a
 * resume to be silently severed). Execution reservation, data, cancellation,
 * file I/O and heartbeat all use independent calls through this dialer.
 */
export class VsockAgentTransport {
	private readonly handle: SandboxAgentHandle
	private readonly connectTimeoutMs: number
	private readonly connectRetryBudgetMs: number
	private readonly connectRetryIntervalMs: number
	private readonly readIdleTimeoutMs: number
	/** Undefined → this transport negotiates no heartbeat at all. */
	private readonly heartbeatMs?: number
	private readonly onDial?: (durationMs: number) => void
	private readonly onDialAttempt?: () => void
	private readonly onGuestReply?: (reply: GuestReplyIdentity) => void
	private readonly maxWriteFileBytes: number
	private readonly writeFilePartBytes?: number
	/**
	 * What the guest advertised in `healthz`, cached for this handle's
	 * lifetime. A pod does not swap its agent binary while it is running,
	 * so the probe is asked once per transport and only when something
	 * actually depends on a capability — an ordinary write, exec, read or
	 * terminal pays nothing for it.
	 */
	private guestFeatureList?: readonly string[]
	private readonly permanentDialFailure?: (error: unknown) => boolean
	private readonly onExecTiming?: (timing: FirecrackerTransportTiming) => void

	constructor(handle: SandboxAgentHandle, options: VsockTransportOptions = {}) {
		this.handle = handle
		this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
		this.connectRetryBudgetMs = options.connectRetryBudgetMs ?? DEFAULT_CONNECT_RETRY_BUDGET_MS
		this.connectRetryIntervalMs =
			options.connectRetryIntervalMs ?? DEFAULT_CONNECT_RETRY_INTERVAL_MS
		this.readIdleTimeoutMs = options.readIdleTimeoutMs ?? DEFAULT_READ_IDLE_TIMEOUT_MS
		if (options.heartbeatMs !== undefined && options.heartbeatMs > 0) {
			this.heartbeatMs = Math.floor(options.heartbeatMs)
		}
		this.onDial = options.onDial
		this.onDialAttempt = options.onDialAttempt
		this.onGuestReply = options.onGuestReply
		this.maxWriteFileBytes = options.maxWriteFileBytes ?? DEFAULT_MAX_WRITE_FILE_BYTES
		if (options.writeFilePartBytes !== undefined) {
			this.writeFilePartBytes = Math.max(1, Math.floor(options.writeFilePartBytes))
		}
		this.permanentDialFailure = options.permanentDialFailure
		this.onExecTiming = options.onExecTiming
	}

	/**
	 * The reserve-before-admission triple this transport hands the shared
	 * {@link RemoteExecutionController}, with `ledger` — when a timing hook
	 * asked for one — accumulating the phases it wraps.
	 *
	 * A FACTORY rather than a constructor-built field, because the ledger is
	 * per call: this transport holds no cross-call connection state (it dials
	 * fresh every time), so building an adapter per `exec()` is free and
	 * makes concurrent `exec()` calls correctly independent — each gets its
	 * own accumulator, with no shared mutable field for two in-flight calls
	 * to race on. Same arrangement, and the same reason, as the kubernetes
	 * tier's `KubernetesAgentTransport.exec`.
	 */
	private executionAdapter(
		ledger?: ExecTimingLedger,
	): RemoteExecutionAdapter<Pick<ExecRequest, 'stdin' | 'maxOutputBytes'>> {
		return {
			label: 'framed microVM agent',
			reserve: async (signal) => {
				if (ledger === undefined) return await this.reserveExecution(signal)
				const startedAt = Date.now()
				try {
					return await this.reserveExecution(signal, ledger)
				} finally {
					ledger.reserveMs += Date.now() - startedAt
				}
			},
			cancel: async (executionId, signal) =>
				await this.cancelExecution(executionId, signal, ledger),
			execute: async (executionId, command, argv, opts, signal, context) => {
				const body: ExecRequest = {
					...(executionId ? { executionId } : {}),
					command,
					args: argv ?? [],
					...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
					...(opts?.env !== undefined ? { env: opts.env } : {}),
					...(opts?.timeout !== undefined ? { timeoutMs: opts.timeout } : {}),
					...(context?.stdin !== undefined ? { stdin: context.stdin } : {}),
					...(context?.maxOutputBytes !== undefined
						? { maxOutputBytes: context.maxOutputBytes }
						: {}),
				}
				if (ledger === undefined) return await this.executeRaw(body, opts, signal)
				const startedAt = Date.now()
				try {
					return await this.executeRaw(body, opts, signal, ledger)
				} finally {
					ledger.executeMs += Date.now() - startedAt
					// Stamped in the `finally` so it is set on the failure path
					// too: a drain interval is only worth reporting when the
					// round trip settled, and "settled" includes "settled by
					// rejecting".
					ledger.executeSettledAt = Date.now()
				}
			},
		}
	}

	/**
	 * Dial the agent with the resume-survival retry budget. Resolves a
	 * connected, post-handshake socket. Retries connect/handshake
	 * failures (ECONNREFUSED while the agent re-listens after a resume,
	 * a dropped CONNECT ack) until the budget is exhausted — or until
	 * {@link VsockTransportOptions.permanentDialFailure} says this particular
	 * failure is not one waiting will cure.
	 */
	private async dial(signal?: AbortSignal, ledger?: ExecTimingLedger): Promise<net.Socket> {
		const deadline = Date.now() + this.connectRetryBudgetMs
		const dialStartedAt = Date.now()
		let lastErr: unknown
		let permanent = false
		for (;;) {
			signal?.throwIfAborted()
			try {
				// Announced BEFORE the attempt, not after it fails: an attempt
				// aborted mid-connect never reaches the catch below, and that
				// is precisely the case a watcher needs to hear about.
				this.onDialAttempt?.()
				const socket = await this.connectOnce(signal)
				const durationMs = Date.now() - dialStartedAt
				this.onDial?.(durationMs)
				// The same interval the hook above reports, folded into the
				// call's own ledger: a caller asking where an exec's wall time
				// went wants it as one number per call, and this dial belongs
				// to that call.
				if (ledger !== undefined) ledger.dialMs += durationMs
				return socket
			} catch (err) {
				if (signal?.aborted) throw signal.reason
				lastErr = err
				if (this.permanentDialFailure?.(err) === true) {
					permanent = true
					break
				}
				if (Date.now() >= deadline) break
				await delay(this.connectRetryIntervalMs, signal)
			}
		}
		throw new AgentDialFailedError(
			// Two wordings, because claiming a 30 s budget was spent on a dial
			// that gave up in 3 ms is a false statement in an error message.
			// Both keep the "could not connect to agent" phrase: that is what
			// callers classifying a dial failure match on.
			permanent
				? `vsock transport: could not connect to agent, and the failure is not one retrying fixes (handle=${describeHandle(
						this.handle,
					)}): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
				: `vsock transport: could not connect to agent within ${this.connectRetryBudgetMs}ms (handle=${describeHandle(
						this.handle,
					)}): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
			{ cause: lastErr },
		)
	}

	private connectOnce(signal?: AbortSignal): Promise<net.Socket> {
		const handle = this.handle
		if (handle.kind === 'mtls') return this.connectOnceMtls(handle, signal)
		if (handle.kind === 'tcp') return this.connectOnceTcp(handle, signal)
		return new Promise<net.Socket>((resolve, reject) => {
			const path = handle.kind === 'unix' ? handle.path : handle.udsPath
			const socket = net.connect({ path })
			let settled = false
			const fail = (err: Error) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				signal?.removeEventListener('abort', abort)
				socket.destroy()
				reject(err)
			}
			const abort = () => fail(signalError(signal))
			const timer = setTimeout(
				() => fail(new Error(`connect/handshake timed out after ${this.connectTimeoutMs}ms`)),
				this.connectTimeoutMs,
			)
			timer.unref()

			socket.once('error', fail)
			if (signal?.aborted) {
				abort()
				return
			}
			signal?.addEventListener('abort', abort, { once: true })

			socket.once('connect', () => {
				if (handle.kind === 'unix') {
					if (settled) return
					settled = true
					clearTimeout(timer)
					signal?.removeEventListener('abort', abort)
					socket.removeListener('error', fail)
					resolve(socket)
					return
				}
				// vsock: issue the firecracker hybrid-vsock CONNECT handshake
				// and wait for the `OK <hostport>` ack line before handing the
				// socket up for framed traffic.
				const port = handle.port
				socket.write(`CONNECT ${port}\n`)
				const ackReader = new LineReader()
				const onData = (chunk: Buffer) => {
					const line = ackReader.push(chunk)
					if (line === undefined) return
					socket.removeListener('data', onData)
					if (!/^OK\b/.test(line)) {
						fail(new Error(`vsock CONNECT ${port} rejected: ${JSON.stringify(line)}`))
						return
					}
					if (settled) return
					settled = true
					clearTimeout(timer)
					signal?.removeEventListener('abort', abort)
					socket.removeListener('error', fail)
					// Any bytes the ackReader over-read after the ack line are
					// application framing; replay them into the caller.
					const leftover = ackReader.takeRemainder()
					if (leftover.length > 0) socket.unshift(leftover)
					resolve(socket)
				}
				socket.on('data', onData)
			})
		})
	}

	/**
	 * Dial the per-FC-host mTLS relay for an `mtls` handle.
	 *
	 * This is a pure TRANSPORT substitution for the `net.connect` arms:
	 * it `tls.connect`s the relay (presenting the fleet client cert and
	 * verifying the relay's server cert, `rejectUnauthorized: true`),
	 * asserts `socket.authorized`, then writes the single routing
	 * preamble line `SANDBOX <sandboxId>\n`. It does NOT write the guest
	 * `CONNECT 1024` line — the relay issues that host-side toward the
	 * jailed `v.sock`. The relay does NOT send an ack line: after the
	 * preamble it is a verbatim byte pump, so the caller hands the
	 * post-preamble socket straight up to the IDENTICAL framing loop the
	 * unix/vsock arms use (a `tls.TLSSocket` IS a `net.Socket`). The
	 * connect-retry budget, idle timeout, and the "fresh connection per
	 * request" resume-survival invariant are inherited unchanged.
	 *
	 * INTEGRATE CONTRACT (must match the relay, Track B): NO ack line.
	 * The relay reads `SANDBOX <id>\n`, then bridges; it writes nothing
	 * back until the agent does. If the relay is ever changed to emit an
	 * `OK` ack first, this arm must await that line (mirroring the vsock
	 * CONNECT-ack path) before resolving — today it does not.
	 */
	private connectOnceMtls(
		handle: Extract<SandboxAgentHandle, { kind: 'mtls' }>,
		signal?: AbortSignal,
	): Promise<net.Socket> {
		return new Promise<net.Socket>((resolve, reject) => {
			const socket = tls.connect({
				host: handle.host,
				port: handle.port,
				ca: handle.tls.ca,
				cert: handle.tls.cert,
				key: handle.tls.key,
				servername: handle.tls.servername,
				rejectUnauthorized: true,
				minVersion: 'TLSv1.3',
			})
			let settled = false
			const fail = (err: Error) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				signal?.removeEventListener('abort', abort)
				socket.destroy()
				reject(err)
			}
			const abort = () => fail(signalError(signal))
			const timer = setTimeout(
				() => fail(new Error(`connect/handshake timed out after ${this.connectTimeoutMs}ms`)),
				this.connectTimeoutMs,
			)
			timer.unref()

			socket.once('error', fail)
			if (signal?.aborted) {
				abort()
				return
			}
			signal?.addEventListener('abort', abort, { once: true })

			// `secureConnect` fires only after the cert chain is verified
			// (rejectUnauthorized rejects a bad/missing-CA server via 'error'
			// before this). Belt-and-suspenders: assert `authorized` too.
			socket.once('secureConnect', () => {
				if (settled) return
				if (!socket.authorized) {
					fail(
						new Error(
							`mtls transport: relay server cert not authorized: ${
								socket.authorizationError ?? 'unknown'
							}`,
						),
					)
					return
				}
				settled = true
				clearTimeout(timer)
				signal?.removeEventListener('abort', abort)
				socket.removeListener('error', fail)
				// Routing preamble — the host-relay analogue of the vsock
				// `CONNECT <port>` line. The relay consumes it, resolves the
				// jailed v.sock, and issues the guest CONNECT itself; the
				// caller writes NOTHING further until the framing loop.
				socket.write(`SANDBOX ${handle.sandboxId}\n`)
				resolve(socket)
			})
		})
	}

	/**
	 * Dial a `tcp` handle: a plain `net.connect({ host, port })`. NO
	 * routing preamble and NO ack — there is no relay to route through
	 * and no handshake line the guest expects, so the socket is handed
	 * to the framing loop the instant it connects, exactly like the
	 * `unix` arm above (whose body this deliberately does not touch).
	 */
	private connectOnceTcp(
		handle: Extract<SandboxAgentHandle, { kind: 'tcp' }>,
		signal?: AbortSignal,
	): Promise<net.Socket> {
		return new Promise<net.Socket>((resolve, reject) => {
			const socket = net.connect({ host: handle.host, port: handle.port })
			// SO_KEEPALIVE on the ROUTED arm only. It proves only that the
			// peer's kernel answers — the application heartbeat is what proves
			// its event loop does — but it is what gets a half-open connection
			// through a middlebox reported at all, and it costs a probe every
			// {@link TCP_KEEPALIVE_INITIAL_DELAY_MS}. The unix/vsock/mtls arms
			// are deliberately untouched: those are the Firecracker tier's.
			socket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS)
			let settled = false
			const fail = (err: Error) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				signal?.removeEventListener('abort', abort)
				socket.destroy()
				reject(err)
			}
			const abort = () => fail(signalError(signal))
			const timer = setTimeout(
				() => fail(new Error(`connect/handshake timed out after ${this.connectTimeoutMs}ms`)),
				this.connectTimeoutMs,
			)
			timer.unref()

			socket.once('error', fail)
			if (signal?.aborted) {
				abort()
				return
			}
			signal?.addEventListener('abort', abort, { once: true })

			socket.once('connect', () => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				signal?.removeEventListener('abort', abort)
				socket.removeListener('error', fail)
				resolve(socket)
			})
		})
	}

	/**
	 * Fold the handle's credential into a request envelope. Only the
	 * `tcp` arm carries a token — the vsock/unix/mtls control channels
	 * are host↔guest only and the agent authenticates nothing there, so
	 * a request built for those arms passes through unchanged.
	 */
	private withCredential(req: AgentRequest): AgentRequest {
		if (this.handle.kind === 'tcp' && this.handle.token !== undefined) {
			return { ...req, token: this.handle.token }
		}
		return req
	}

	/**
	 * Refuse an oversized `tcp` envelope BEFORE dialing. See
	 * {@link TCP_PREAUTH_FRAME_LIMIT_BYTES}. A no-op for every other
	 * handle kind, which the guest never gates on frame size pre-auth.
	 */
	private assertPreauthBudget(payload: string): void {
		if (this.handle.kind !== 'tcp') return
		const size = Buffer.byteLength(payload, 'utf8')
		if (size <= TCP_PREAUTH_FRAME_LIMIT_BYTES) return
		throw new AgentPreauthFrameTooLargeError(
			`kubernetes tcp transport: request envelope is ${size} bytes, which exceeds the ${TCP_PREAUTH_FRAME_LIMIT_BYTES}-byte limit the guest agent enforces on an unauthenticated connection's first frame (NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES, default 8 MiB). Every tcp request dials a fresh connection, so this request WOULD be that connection's first frame. A large \`write-file\` body is split across frames automatically (see \`writeFile\`); every other op has to fit, so reduce the payload or raise the deployment's NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES.`,
		)
	}

	/**
	 * Hand one accepted reply to {@link VsockTransportOptions.onGuestReply},
	 * and never let the listener's failure reach the caller.
	 *
	 * The caller's result is already decided by the time this runs — the
	 * reply parsed, the frame accounted for — so a hook that throws must not
	 * turn a successful read into a failed one. Swallowing is the only
	 * behaviour that keeps an optional observer optional.
	 */
	private observeGuestReply(reply: unknown): void {
		const observe = this.onGuestReply
		if (observe === undefined) return
		if (reply === null || typeof reply !== 'object') return
		try {
			observe(reply as GuestReplyIdentity)
		} catch {
			// See above: an observer cannot fail an operation.
		}
	}

	/**
	 * Send one framed request and read one framed JSON reply (file-IO +
	 * healthz). Applies the read-idle timeout so a post-resume hung read
	 * is torn down rather than wedging the caller.
	 */
	async request<T>(req: AgentRequest, signal?: AbortSignal): Promise<T> {
		return await this.requestFramed<T>(req, signal)
	}

	/**
	 * {@link request}, with the one thing the public signature has no place
	 * for: the exec call's timing ledger, so the reserve round trip that
	 * reaches the guest through this method is counted against the call that
	 * paid for its dial. Private rather than a third parameter, because a
	 * public method whose extra argument exists only for internal
	 * instrumentation is a parameter a caller can only misuse.
	 */
	private async requestFramed<T>(
		req: AgentRequest,
		signal?: AbortSignal,
		ledger?: ExecTimingLedger,
	): Promise<T> {
		const envelope = this.withCredential(req)
		const payload = JSON.stringify(envelope)
		this.assertPreauthBudget(payload)
		const socket = await this.dial(signal, ledger)
		return await new Promise<T>((resolve, reject) => {
			const reader = new FrameReader()
			let settled = false
			let response: T | undefined
			let closeTimer: ReturnType<typeof setTimeout> | undefined
			const finish = (err: Error | null, value?: T) => {
				if (settled) return
				settled = true
				idle.clear()
				if (closeTimer) clearTimeout(closeTimer)
				signal?.removeEventListener('abort', abort)
				socket.destroy()
				if (err) reject(err)
				else resolve(value as T)
			}
			const abort = () => finish(signalError(signal))
			const idle = new IdleTimer(this.readIdleTimeoutMs, () =>
				finish(new Error(`vsock transport: read idle timeout after ${this.readIdleTimeoutMs}ms`)),
			)
			socket.on('data', (chunk: Buffer) => {
				idle.bump()
				if (response !== undefined) {
					finish(new Error('vsock transport: control reply emitted data after its response'))
					return
				}
				let frames: string[]
				try {
					frames = reader.push(chunk)
				} catch (err) {
					finish(err instanceof Error ? err : new Error(String(err)))
					return
				}
				if (frames.length > 1) {
					finish(new Error('vsock transport: control reply emitted multiple frames'))
					return
				}
				const first = frames[0]
				if (first !== undefined) {
					try {
						response = JSON.parse(first) as T
						this.observeGuestReply(response)
						if (reader.bufferedBytes > 0) {
							finish(new Error('vsock transport: control reply has trailing partial data'))
							return
						}
						idle.clear()
						closeTimer = setTimeout(
							() => finish(new Error('vsock transport: control peer did not close after reply')),
							POST_RESPONSE_CLOSE_TIMEOUT_MS,
						)
						closeTimer.unref()
					} catch (err) {
						finish(err instanceof Error ? err : new Error(String(err)))
					}
				}
			})
			socket.once('error', (err) => finish(err))
			socket.once('close', () => {
				if (response !== undefined) finish(null, response)
				else finish(new Error('vsock transport: socket closed before reply'))
			})
			if (signal?.aborted) {
				abort()
				return
			}
			signal?.addEventListener('abort', abort, { once: true })
			idle.bump()
			socket.write(frame(payload))
		})
	}

	/**
	 * Send an `/execute` and accumulate the streamed NDJSON frames into a
	 * {@link SandboxExecResult} via the shared {@link ExecResultAccumulator}.
	 * The agent terminates the stream with a zero-length frame.
	 */
	private async executeRaw(
		body: ExecRequest,
		opts?: SandboxExecOptions,
		signal?: AbortSignal,
		ledger?: ExecTimingLedger,
	): Promise<SandboxExecResult> {
		const envelope = this.withCredential({ op: 'execute', body } satisfies AgentRequest)
		const payload = JSON.stringify(envelope)
		this.assertPreauthBudget(payload)
		const socket = await this.dial(signal, ledger)
		const start = Date.now()
		// The instant the request goes on the wire. The three execute
		// sub-phases of {@link FirecrackerTransportTiming} are measured from
		// here, so they answer "how long after the guest was asked" rather
		// than "how long after this call began" — the dial that precedes it
		// is already counted in `dialMs` and inside `executeMs`.
		let writtenAt = 0
		// Stamped once, when the terminator frame is parsed, so `peerCloseMs`
		// measures the peer's close and not the whole round trip.
		let terminatorAt = 0
		return await new Promise<SandboxExecResult>((resolve, reject) => {
			const reader = new FrameReader()
			const acc = new ExecResultAccumulator(start, opts?.onOutput)
			let settled = false
			let terminated = false
			let terminalResult: SandboxExecResult | undefined
			let closeTimer: ReturnType<typeof setTimeout> | undefined
			const requestedTimeout =
				typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs) && body.timeoutMs > 0
					? body.timeoutMs
					: DEFAULT_EXECUTION_TIMEOUT_MS
			const observationTimeoutMs = Math.min(
				MAX_TIMER_DELAY_MS,
				requestedTimeout + EXECUTION_TRANSPORT_GRACE_MS,
			)
			const finish = (err: Error | null, value?: SandboxExecResult) => {
				if (settled) return
				settled = true
				clearTimeout(observationTimer)
				if (closeTimer) clearTimeout(closeTimer)
				signal?.removeEventListener('abort', abort)
				socket.destroy()
				if (err) reject(err)
				else resolve(value as SandboxExecResult)
			}
			const abort = () => finish(signalError(signal))
			const observationTimer = setTimeout(
				() =>
					finish(
						new Error(`vsock transport: execution observation exceeded ${observationTimeoutMs}ms`),
					),
				observationTimeoutMs,
			)
			observationTimer.unref()
			socket.on('data', (chunk: Buffer) => {
				if (terminated) {
					finish(new Error('vsock transport: exec stream emitted data after its terminator'))
					return
				}
				let frames: string[]
				try {
					frames = reader.push(chunk)
				} catch (err) {
					finish(err instanceof Error ? err : new Error(String(err)))
					return
				}
				// Recorded before the terminator check below and before any
				// parsing: the first frame ARRIVED, which stays true even if
				// this call goes on to reject over the frame's contents.
				if (ledger !== undefined && ledger.firstFrameMs === undefined && frames.length > 0) {
					ledger.firstFrameMs = Date.now() - writtenAt
				}
				for (const payload of frames) {
					if (terminated) {
						finish(new Error('vsock transport: exec stream emitted data after its terminator'))
						return
					}
					if (payload.length === 0) {
						if (!acc.done) {
							finish(new Error('exec stream ended without a result event'))
							return
						}
						terminated = true
						continue
					}
					try {
						const event = parseExecLine(payload)
						if (event) acc.push(event)
					} catch (err) {
						finish(err instanceof Error ? err : new Error(String(err)))
						return
					}
				}
				if (terminated) {
					// The terminator WAS read, so it is reported even if this
					// call is about to reject over what followed it: the
					// question these numbers answer is where the time went,
					// not whether the call ended well.
					if (ledger !== undefined && ledger.terminatorMs === undefined) {
						terminatorAt = Date.now()
						ledger.terminatorMs = terminatorAt - writtenAt
					}
					if (reader.bufferedBytes > 0) {
						finish(new Error('vsock transport: exec stream has trailing partial data'))
						return
					}
					terminalResult = acc.finish()
					closeTimer = setTimeout(
						() => finish(new Error('vsock transport: exec peer did not close after terminator')),
						POST_RESPONSE_CLOSE_TIMEOUT_MS,
					)
					closeTimer.unref()
				}
			})
			socket.once('error', (err) => finish(err))
			socket.once('close', () => {
				// A close that arrives with this call ALREADY settled is one
				// this transport caused itself: `finish` is the only writer of
				// `settled` and its next statement is `socket.destroy()`, so
				// the guard timer, the observation timer and the caller's abort
				// each destroy the socket and then react to the `close` that
				// destroy emits. Crediting the peer for it would report
				// {@link POST_RESPONSE_CLOSE_TIMEOUT_MS} — a constant this
				// transport chose — as a duration the peer took, in exactly the
				// case a host is reading the field to diagnose. The same rule
				// `readFileFrames` applies in the same position: an end this
				// side already reached is not news.
				if (settled) return
				if (terminated && terminalResult) {
					if (ledger !== undefined && terminatorAt > 0) {
						ledger.peerCloseMs = Date.now() - terminatorAt
					}
					finish(null, terminalResult)
				} else finish(new Error('vsock transport: socket closed before exec stream terminator'))
			})
			if (signal?.aborted) {
				abort()
				return
			}
			signal?.addEventListener('abort', abort, { once: true })
			writtenAt = Date.now()
			socket.write(frame(payload))
		})
	}

	/**
	 * Compatibility request-shaped entry point. It now enters the same
	 * reserve-before-admission controller as {@link exec}; the raw data-plane
	 * primitive is deliberately private so aborting this public method cannot
	 * abandon a live guest command.
	 */
	async execute(
		body: ExecRequest,
		opts?: SandboxExecOptions,
		signal?: AbortSignal,
	): Promise<SandboxExecResult> {
		if (body.executionId !== undefined) {
			throw new RemoteProtocolError(
				'VsockAgentTransport.execute does not accept caller-owned execution ids',
			)
		}
		return await this.runExec(
			body.command,
			body.args ? [...body.args] : undefined,
			{
				...opts,
				...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
				...(body.env !== undefined ? { env: body.env } : {}),
				...(body.timeoutMs !== undefined ? { timeout: body.timeoutMs } : {}),
				...(opts?.signal === undefined && signal !== undefined ? { signal } : {}),
			},
			{
				...(body.stdin !== undefined ? { stdin: body.stdin } : {}),
				...(body.maxOutputBytes !== undefined ? { maxOutputBytes: body.maxOutputBytes } : {}),
			},
		)
	}

	async exec(
		command: string,
		argv?: string[],
		opts?: SandboxExecOptions,
	): Promise<SandboxExecResult> {
		return await this.runExec(command, argv, opts)
	}

	/**
	 * One command through a call-scoped adapter + controller, reporting the
	 * call's phases to {@link VsockTransportOptions.onExecTiming} when a host
	 * asked for them.
	 *
	 * The ledger is created HERE and nowhere else — because it is per call,
	 * not per transport, so two concurrent `exec()` calls each get their own
	 * accumulator. Constructing a controller per call costs an allocation and
	 * nothing else: the controller's only per-instance state is its readonly
	 * configuration, so a fresh one behaves exactly like a shared one, and
	 * this transport dials fresh per request either way.
	 *
	 * The hook fires in a `finally`, on the failure paths as well as the
	 * happy one: an exec that rejected after its reserve round trip is
	 * precisely the call whose phase breakdown a host needs. Measuring into a
	 * ledger that nobody reads is what "no hook, no cost" means here — with
	 * no hook there is no ledger, and the `undefined` checks in `dial` and
	 * `executeRaw` skip the clock reads entirely.
	 */
	private async runExec(
		command: string,
		argv: string[] | undefined,
		opts: SandboxExecOptions | undefined,
		context?: Pick<ExecRequest, 'stdin' | 'maxOutputBytes'>,
	): Promise<SandboxExecResult> {
		const hook = this.onExecTiming
		if (hook === undefined) {
			return await new RemoteExecutionController(this.executionAdapter()).exec(
				command,
				argv,
				opts,
				context,
			)
		}
		const ledger: ExecTimingLedger = {
			dialMs: 0,
			reserveMs: 0,
			executeMs: 0,
			executeSettledAt: 0,
		}
		try {
			return await new RemoteExecutionController(this.executionAdapter(ledger)).exec(
				command,
				argv,
				opts,
				context,
			)
		} finally {
			// Caught, not propagated: this hook is an OBSERVER, and a listener
			// that throws must not turn a command that ran into a caller's
			// exception — the rule {@link VsockTransportOptions.onGuestReply}
			// already states for this transport's other observers. A `finally`
			// that let it through would replace the call's own error with the
			// listener's, which is the worst version of that failure.
			try {
				hook(timingOf(ledger))
			} catch {
				// The listener's problem, and only the listener's.
			}
		}
	}

	/**
	 * The raw `/execute` primitive with NO admission/reservation
	 * semantics: dial, send one framed request, accumulate the streamed
	 * NDJSON reply. Public (unlike the identical-in-spirit
	 * {@link reserveExecution}/{@link cancelExecution}, reached through
	 * the already-public {@link request}) so a caller running its OWN
	 * {@link RemoteExecutionController} — the kubernetes backend's
	 * adapter — can reuse this exact dial + framing rather than
	 * reimplementing it, while still supplying that controller its own
	 * `reserve`/`cancel`/`execute` triple as {@link RemoteExecutionAdapter}
	 * requires. Callers that just want a reserve-before-admission `exec`
	 * should use {@link execute} or {@link exec} instead.
	 */
	async executeStreamed(
		body: ExecRequest,
		opts?: SandboxExecOptions,
		signal?: AbortSignal,
	): Promise<SandboxExecResult> {
		return await this.executeRaw(body, opts, signal)
	}

	private async reserveExecution(signal: AbortSignal, ledger?: ExecTimingLedger): Promise<unknown> {
		const response = await this.requestFramed<Record<string, unknown>>(
			{ op: 'reserve-execution' },
			signal,
			ledger,
		)
		if (
			response.ok === false &&
			typeof response.error === 'string' &&
			response.error.startsWith('unknown_op:')
		) {
			throw new RemoteProtocolError(
				`The microVM guest does not implement Firecracker agent protocol ${FIRECRACKER_AGENT_PROTOCOL_VERSION}. Rebuild the golden image from the same Namzu release before admitting commands.`,
			)
		}
		if (response.ok === false && response.error === 'agent_retiring') {
			throw new RemoteCancellationUnknownError(
				'The microVM agent has fenced itself because an earlier process-group shutdown could not be confirmed; the sandbox must be retired.',
			)
		}
		return response
	}

	private async cancelExecution(
		executionId: string,
		signal: AbortSignal,
		ledger?: ExecTimingLedger,
	): Promise<unknown> {
		return await this.requestFramed<unknown>(
			{ op: 'cancel-execution', body: { executionId } },
			signal,
			ledger,
		)
	}

	/** Readiness probe. A healthy guest must also speak the exact host protocol. */
	async healthz(signal?: AbortSignal): Promise<boolean> {
		try {
			const res = await this.request<{
				ok?: boolean
				protocolVersion?: unknown
				features?: unknown
			}>({ op: 'healthz' }, signal)
			if (res.ok !== true) return false
			if (res.protocolVersion !== FIRECRACKER_AGENT_PROTOCOL_VERSION) {
				const actual =
					res.protocolVersion === undefined ? 'missing' : JSON.stringify(res.protocolVersion)
				throw new RemoteProtocolError(
					`Firecracker guest protocol version mismatch: expected ${FIRECRACKER_AGENT_PROTOCOL_VERSION}, received ${actual}. Rebuild the golden image from the same Namzu release.`,
				)
			}
			// The reply that answers readiness also answers what the guest can
			// do, so the capability caches are filled here rather than by a
			// second probe later. What that saves depends on the tier: the
			// Firecracker backend fences on `waitForReady` after create, so
			// its first `readFile` costs one connection, while the Kubernetes
			// backend fences on the pod's ready condition and never calls
			// this — so its first read of a transport's life pays one extra
			// dial to ask, and every read after it is back to one.
			//
			// AFTER both checks, not before: a reply this method is about to
			// reject is not a reply to believe about anything else, and a
			// guest that is not ready is one whose features are not yet known
			// rather than one that has none.
			this.guestFeatureList = Array.isArray(res.features)
				? res.features.filter((value): value is string => typeof value === 'string')
				: []
			return true
		} catch (error) {
			if (signal?.aborted) throw signal.reason
			if (error instanceof RemoteProtocolError) throw error
			return false
		}
	}

	/**
	 * Poll the agent until a healthz succeeds or the timeout elapses.
	 * Mirrors the HTTP `waitForWorkerReady`, but over the vsock dialer
	 * (which already carries connect retry) — used by the backend's
	 * post-create readiness fence.
	 */
	async waitForReady(
		timeoutMs: number,
		pollIntervalMs: number,
		signal?: AbortSignal,
	): Promise<void> {
		const deadline = new OperationDeadline(timeoutMs, 'firecracker agent readiness', signal)
		let lastErr: unknown
		while (deadline.remainingMs() > 0) {
			try {
				if (await deadline.run((signal) => this.healthz(signal))) return
				lastErr = new Error('healthz returned not-ok')
			} catch (err) {
				lastErr = err
				if (err instanceof RemoteProtocolError) throw err
				if (err instanceof OperationDeadlineExpired) break
			}
			try {
				await deadline.delay(pollIntervalMs)
			} catch (err) {
				if (err instanceof OperationDeadlineExpired) break
				throw err
			}
		}
		throw new Error(
			`vsock transport: agent did not become ready within ${timeoutMs}ms: ${
				lastErr instanceof Error ? lastErr.message : String(lastErr)
			}`,
		)
	}

	/**
	 * Write a whole file into the guest workspace.
	 *
	 * A body that fits one frame goes as it always has: a single
	 * `write-file` envelope carrying the base64 content, one round trip,
	 * byte-for-byte the request this transport has always sent.
	 *
	 * A body that does NOT fit is the case this exists for. On the `tcp`
	 * arm every request dials a fresh connection, so every request is that
	 * connection's first, not-yet-authenticated frame (the credential
	 * rides in the envelope) and is bounded by
	 * {@link TCP_PREAUTH_FRAME_LIMIT_BYTES} — about 5.9 MiB of file
	 * content — on EVERY call, not once. Raising the guest's
	 * `NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES` trades away the pre-auth
	 * budget that ceiling exists to bound, so the fix is on this side:
	 * split the body into parts that each fit, append them to a temporary
	 * SIBLING of the target inside the same workspace jail, and finish
	 * with an atomic `rename` onto the target.
	 *
	 * What that buys, and why the shape is what it is:
	 *
	 *  - **A reader never sees a half-written file.** The target changes
	 *    exactly once, in the final part's `rename`. A sequence that dies
	 *    at part 3 of 9 leaves the target exactly as it was — including
	 *    not existing.
	 *  - **A lost or duplicated part is detected, not written.** Each part
	 *    names the offset it starts at and the guest refuses it unless
	 *    that equals the temp file's current size.
	 *  - **An abandoned sequence cleans up after itself.** An abort or a
	 *    transport failure removes the temp file (best effort — a peer
	 *    that has gone away cannot be asked to) and rejects.
	 *  - **Parts go out sequentially on fresh connections**, which is what
	 *    the offset check assumes and what keeps the guest's pre-auth
	 *    connection pool holding one of this caller's sockets at a time.
	 *
	 * The guest must ADVERTISE the capability (`${WRITE_FILE_PARTS_FEATURE}`
	 * in its `healthz` reply) before a single part is sent. An agent that
	 * predates the part protocol would read a part's `content` as a whole
	 * file; it never receives one, and an oversized body against such a
	 * guest still fails with the named
	 * {@link AgentPreauthFrameTooLargeError} it always did.
	 *
	 * {@link VsockTransportOptions.maxWriteFileBytes} is checked FIRST, on
	 * every body and before anything about the wire is considered: it is a
	 * bound on what a caller may push into a workspace, not a bound on
	 * multi-part writes, so a host that lowers it below the frame budget
	 * gets the cap it asked for rather than none.
	 */
	async writeFile(path: string, content: Buffer, signal?: AbortSignal): Promise<void> {
		if (content.length > this.maxWriteFileBytes) {
			throw new AgentWriteFileTooLargeError(
				`write-file: a body of ${content.length} bytes exceeds this transport's maxWriteFileBytes of ${this.maxWriteFileBytes}. Raise VsockTransportOptions.maxWriteFileBytes to admit it.`,
			)
		}
		const budget = this.singleFrameBudgetBytes()
		const wholeEnvelopeBytes = this.writeFileEnvelopeBytes(
			{ path, content: '', encoding: 'base64' },
			content.length,
		)
		// The configured part size, when there is one, also decides when a
		// body is split at all — so that with NO configuration the split
		// point is exactly the wire's own ceiling and every body that used
		// to travel in one frame still does.
		const splitsAnyway =
			this.writeFilePartBytes !== undefined && content.length > this.writeFilePartBytes
		if (wholeEnvelopeBytes <= budget && !splitsAnyway) {
			await this.writeFileWhole(path, content, signal)
			return
		}
		if (!(await this.guestSupportsWriteFileParts(signal))) {
			throw this.oversizedWriteFileError(content.length, wholeEnvelopeBytes, budget)
		}
		await this.writeFileInParts(path, content, budget, signal)
	}

	/** Today's single-frame write, unchanged — see {@link writeFile}. */
	private async writeFileWhole(path: string, content: Buffer, signal?: AbortSignal): Promise<void> {
		const res = await this.request<WriteFileResponse>(
			{
				op: 'write-file',
				body: { path, content: content.toString('base64'), encoding: 'base64' },
			},
			signal,
		)
		if (!res.ok) {
			throw new Error(res.error ?? 'write-file failed')
		}
	}

	/**
	 * The frame budget one request has on this handle: the pre-auth
	 * ceiling on the credentialed `tcp` arm, the guest's global frame
	 * ceiling on the host-local arms, which authenticate nothing and so
	 * never pay the smaller price.
	 */
	private singleFrameBudgetBytes(): number {
		return this.handle.kind === 'tcp' ? TCP_PREAUTH_FRAME_LIMIT_BYTES : GUEST_FRAME_LIMIT_BYTES
	}

	/**
	 * Exact framed size of a `write-file` envelope whose `content` field
	 * holds `contentBytes` raw bytes base64-encoded — WITHOUT encoding
	 * them, so sizing a 1 GiB body costs nothing and never builds a string
	 * longer than V8 permits.
	 *
	 * Exact rather than approximate because the base64 alphabet contains
	 * no character `JSON.stringify` escapes, so the encoded content
	 * contributes precisely its own length to the envelope and the rest of
	 * the envelope (paths, the token, the part fields) is measured as it
	 * will actually be serialized.
	 */
	private writeFileEnvelopeBytes(body: WriteFileRequest, contentBytes: number): number {
		const envelope = this.withCredential({ op: 'write-file', body } satisfies AgentRequest)
		return Buffer.byteLength(JSON.stringify(envelope), 'utf8') + base64Length(contentBytes)
	}

	/**
	 * Ask the guest whether it implements the part protocol. Cached for
	 * the transport's lifetime; a transport failure propagates rather than
	 * reading as "not supported", because answering a broken connection
	 * with a too-large error would name the wrong cause.
	 */
	private async guestSupportsWriteFileParts(signal?: AbortSignal): Promise<boolean> {
		return (await this.guestFeatures(signal)).includes(WRITE_FILE_PARTS_FEATURE)
	}

	/**
	 * The capability strings this guest advertises in `healthz`, cached for
	 * this transport's lifetime.
	 *
	 * One list, asked once, for every optional op: the write-file part
	 * protocol and the execution-attach ops both read it, and a second
	 * cache would mean a second probe against a guest that answers both
	 * questions in one reply. A transport FAILURE propagates rather than
	 * reading as "not supported", because answering a broken connection
	 * with a capability refusal would name the wrong cause.
	 */
	async guestFeatures(signal?: AbortSignal): Promise<readonly string[]> {
		if (this.guestFeatureList !== undefined) return this.guestFeatureList
		const reply = await this.request<{ features?: unknown }>({ op: 'healthz' }, signal)
		const features = Array.isArray(reply.features)
			? reply.features.filter((value): value is string => typeof value === 'string')
			: []
		this.guestFeatureList = features
		return features
	}

	/**
	 * Send one framed request and read a STREAM of framed JSON events until
	 * the agent's zero-length terminator, handing each event to `onEvent`.
	 *
	 * The generic half of what {@link executeRaw} does, without any of its
	 * opinions about what the events mean: `executeRaw` owns the exec
	 * NDJSON union and the {@link ExecResultAccumulator}, and this owns
	 * dial, framing, the terminator, the observation bound and the
	 * post-terminator close. Additive — nothing already shipped calls it —
	 * so the Firecracker tier's behaviour is untouched and a later streamed
	 * op reuses it rather than writing a fourth copy of this loop.
	 *
	 * There is deliberately NO read-idle timeout. A stream that exists to
	 * follow a long, quiet command must not be torn down for being quiet;
	 * the whole observation is bounded by `observationTimeoutMs` instead,
	 * exactly as an `execute` stream is.
	 */
	async streamFramedRequest(
		req: AgentRequest,
		onEvent: (event: Record<string, unknown>) => void,
		options: { readonly observationTimeoutMs: number },
		signal?: AbortSignal,
	): Promise<void> {
		const envelope = this.withCredential(req)
		const payload = JSON.stringify(envelope)
		this.assertPreauthBudget(payload)
		const socket = await this.dial(signal)
		const observationTimeoutMs = Math.min(MAX_TIMER_DELAY_MS, options.observationTimeoutMs)
		return await new Promise<void>((resolve, reject) => {
			const reader = new FrameReader()
			let settled = false
			let terminated = false
			let closeTimer: ReturnType<typeof setTimeout> | undefined
			const finish = (err: Error | null) => {
				if (settled) return
				settled = true
				clearTimeout(observationTimer)
				if (closeTimer) clearTimeout(closeTimer)
				signal?.removeEventListener('abort', abort)
				socket.destroy()
				if (err) reject(err)
				else resolve()
			}
			const abort = () => finish(signalError(signal))
			const observationTimer = setTimeout(
				() =>
					finish(
						new Error(`vsock transport: stream observation exceeded ${observationTimeoutMs}ms`),
					),
				observationTimeoutMs,
			)
			observationTimer.unref()
			socket.on('data', (chunk: Buffer) => {
				let frames: string[]
				try {
					frames = reader.push(chunk)
				} catch (err) {
					finish(err instanceof Error ? err : new Error(String(err)))
					return
				}
				for (const frameText of frames) {
					if (terminated) {
						finish(new Error('vsock transport: stream emitted data after its terminator'))
						return
					}
					if (frameText.length === 0) {
						terminated = true
						continue
					}
					let event: Record<string, unknown>
					try {
						event = JSON.parse(frameText) as Record<string, unknown>
					} catch (err) {
						finish(err instanceof Error ? err : new Error(String(err)))
						return
					}
					try {
						onEvent(event)
					} catch (err) {
						finish(err instanceof Error ? err : new Error(String(err)))
						return
					}
				}
				if (terminated) {
					if (reader.bufferedBytes > 0) {
						finish(new Error('vsock transport: stream has trailing partial data'))
						return
					}
					closeTimer = setTimeout(
						() => finish(new Error('vsock transport: stream peer did not close after terminator')),
						POST_RESPONSE_CLOSE_TIMEOUT_MS,
					)
					closeTimer.unref()
				}
			})
			socket.once('error', (err) => finish(err))
			socket.once('close', () => {
				if (terminated) finish(null)
				else finish(new Error('vsock transport: socket closed before stream terminator'))
			})
			if (signal?.aborted) {
				abort()
				return
			}
			signal?.addEventListener('abort', abort, { once: true })
			socket.write(frame(payload))
		})
	}

	/** The refusal for a body no frame can carry and no guest can take in parts. */
	private oversizedWriteFileError(
		contentBytes: number,
		envelopeBytes: number,
		budget: number,
	): Error {
		const missing = `This guest does not advertise the '${WRITE_FILE_PARTS_FEATURE}' healthz feature, so the body cannot be split across frames either; rebuild the guest image from this Namzu release, or reduce the payload.`
		if (this.handle.kind === 'tcp') {
			return new AgentPreauthFrameTooLargeError(
				`kubernetes tcp transport: a write-file of ${contentBytes} bytes needs a ${envelopeBytes}-byte request envelope, which exceeds the ${TCP_PREAUTH_FRAME_LIMIT_BYTES}-byte limit the guest agent enforces on an unauthenticated connection's first frame (NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES, default 8 MiB). Every tcp request dials a fresh connection, so this request WOULD be that connection's first frame. ${missing} Raising the deployment's NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES also admits it, at the cost of the pre-auth budget that ceiling bounds.`,
			)
		}
		return new Error(
			`vsock transport: a write-file of ${contentBytes} bytes needs a ${envelopeBytes}-byte request envelope, which exceeds the ${budget}-byte frame ceiling the guest agent enforces (NAMZU_AGENT_MAX_FRAME_BYTES, default 256 MiB). ${missing}`,
		)
	}

	/**
	 * Write `content` to `target` as a sequence of parts. See
	 * {@link writeFile} for why this shape.
	 */
	private async writeFileInParts(
		target: string,
		content: Buffer,
		budget: number,
		signal?: AbortSignal,
	): Promise<void> {
		const tempPath = writeFilePartTempPath(target)
		// Sized against the LARGEST part envelope the sequence will send:
		// the final one, which carries `renameTo` and the largest offset.
		// Every earlier part is smaller, so none of them can overrun.
		const envelopeOverhead = this.writeFileEnvelopeBytes(
			{
				path: tempPath,
				content: '',
				encoding: 'base64',
				part: { offset: content.length, final: true, renameTo: target },
			},
			0,
		)
		const room = budget - envelopeOverhead - WRITE_FILE_PART_HEADROOM_BYTES
		const framePartBytes = Math.floor(room / 4) * 3
		if (framePartBytes <= 0) {
			throw new AgentWriteFileTooLargeError(
				`write-file: the request envelope for a part of '${target}' is ${envelopeOverhead} bytes, leaving no room for content inside the ${budget}-byte frame budget. The path is too long for this transport to write in parts.`,
			)
		}
		const partBytes = Math.min(framePartBytes, this.writeFilePartBytes ?? framePartBytes)

		let offset = 0
		try {
			for (;;) {
				signal?.throwIfAborted()
				const end = Math.min(offset + partBytes, content.length)
				const final = end >= content.length
				const res = await this.request<WriteFileResponse>(
					{
						op: 'write-file',
						body: {
							path: tempPath,
							content: content.subarray(offset, end).toString('base64'),
							encoding: 'base64',
							part: { offset, final, ...(final ? { renameTo: target } : {}) },
						},
					},
					signal,
				)
				if (!res.ok) {
					throw new Error(res.error ?? 'write-file part failed')
				}
				offset = end
				if (!final) continue
				if (typeof res.sizeBytes === 'number' && res.sizeBytes !== content.length) {
					throw new Error(
						`vsock transport: write-file assembled ${res.sizeBytes} bytes for '${target}', expected ${content.length}`,
					)
				}
				return
			}
		} catch (error) {
			await this.discardWriteFileTemp(tempPath)
			throw error
		}
	}

	/**
	 * Remove an abandoned part file. Best effort BY CONTRACT: the reason
	 * the sequence failed is frequently that the guest is unreachable, and
	 * a cleanup that threw would replace the caller's real error — the one
	 * that says why the write failed — with a second one about tidying up.
	 */
	private async discardWriteFileTemp(tempPath: string): Promise<void> {
		try {
			await this.request<WriteFileResponse>(
				{
					op: 'write-file',
					body: { path: tempPath, content: '', encoding: 'base64', part: { discard: true } },
				},
				AbortSignal.timeout(WRITE_FILE_DISCARD_TIMEOUT_MS),
			)
		} catch {
			// Deliberately swallowed; see the doc comment.
		}
	}

	/**
	 * Read a file out of the guest.
	 *
	 * Three shapes, decided by what the guest advertises and what the
	 * caller asked for:
	 *
	 *  - **No options, guest advertises {@link READ_FILE_STREAM_FEATURE}** —
	 *    served by {@link readFileStream} and concatenated here. Neither
	 *    side ever holds the base64 form or the JSON envelope whole, so the
	 *    ~384 MiB ceiling (V8 refuses a string longer than `0x1fffffe8`
	 *    characters, which is what a base64-encoded file of that size
	 *    needs) is gone and the guest's peak stops tracking the file's
	 *    size. The result is still one `Buffer`, because that is what this
	 *    method returns; a caller that must not hold even that iterates
	 *    {@link readFileStream} directly.
	 *  - **No options, guest does not advertise it** — today's single
	 *    whole-file reply, byte for byte, with today's ceiling.
	 *  - **`offset` and `length`** — one ranged `read-file`: a single round
	 *    trip for a single slice, which is the point of asking for one.
	 *    `offset` WITHOUT `length` is an unbounded tail, so it goes through
	 *    the stream instead; the guest refuses an uncapped range on
	 *    `read-file` for exactly that reason.
	 *
	 * A ranged read against a guest that does not advertise the feature is
	 * REFUSED with {@link AgentReadFileStreamUnsupportedError} rather than
	 * downgraded: such an agent ignores `offset`/`length` and answers with
	 * the whole file, which the caller would read as its slice.
	 */
	async readFile(path: string, options?: SandboxReadFileOptions): Promise<Buffer> {
		const signal = options?.signal
		const { offset, length } = options ?? {}
		if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
			throw new Error('readFile: offset must be a non-negative safe integer')
		}
		if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) {
			throw new Error('readFile: length must be a non-negative safe integer')
		}
		const ranged = offset !== undefined || length !== undefined
		if (!(await this.guestSupportsReadFileStream(signal))) {
			if (ranged) {
				throw new AgentReadFileStreamUnsupportedError(
					`read-file: this guest does not advertise the '${READ_FILE_STREAM_FEATURE}' healthz feature, so it would ignore offset/length and answer with the whole file. Rebuild the guest image from this Namzu release, or read the file whole.`,
				)
			}
			return await this.readFileWhole(path, signal)
		}
		if (length !== undefined) {
			return await this.readFileRange(path, offset ?? 0, length, signal)
		}
		// Copied into ONE buffer sized from the guest's `meta` frame rather
		// than collected and `Buffer.concat`ed: concat needs every chunk to
		// still exist when the whole is built, so it costs twice the file at
		// the moment it finishes — 2.3x measured on a 256 MiB read, against
		// the 2x this method is held to. Here the peak is the file plus one
		// chunk. The guest's own `end` frame is checked against what arrived
		// (see {@link readFileFrames}), so a short stream rejects rather than
		// handing back a buffer padded with whatever was in the allocation.
		let out: Buffer | undefined
		let at = 0
		for await (const chunk of this.readFileFrames(path, options, (meta) => {
			// The one guest-supplied number this side turns into an
			// allocation, so it is the one worth bounding. The guest derives
			// `length` and `sizeBytes` from the same `stat` and never
			// announces more of a file than the file has, so a `length` past
			// `sizeBytes` is a guest this host should not be sizing a buffer
			// from. `allocUnsafe` would refuse the extreme values on its own;
			// this makes the refusal name what was wrong with the frame.
			if (
				!Number.isSafeInteger(meta.sizeBytes) ||
				meta.sizeBytes < 0 ||
				!Number.isSafeInteger(meta.length) ||
				meta.length < 0 ||
				meta.length > meta.sizeBytes
			) {
				throw new Error(
					`vsock transport: read-file-stream announced ${meta.length} bytes of a ${meta.sizeBytes}-byte file`,
				)
			}
			out = Buffer.allocUnsafe(meta.length)
		})) {
			if (out === undefined) {
				throw new Error('vsock transport: read-file-stream sent data before its meta frame')
			}
			if (at + chunk.byteLength > out.length) {
				throw new Error(
					`vsock transport: read-file-stream delivered more than the ${out.length} bytes it announced`,
				)
			}
			chunk.copy(out, at)
			at += chunk.byteLength
		}
		return out === undefined ? Buffer.alloc(0) : out.subarray(0, at)
	}

	/** Today's single whole-file reply, unchanged — see {@link readFile}. */
	private async readFileWhole(path: string, signal?: AbortSignal): Promise<Buffer> {
		const res = await this.request<ReadFileResponse>(
			{ op: 'read-file', body: { path, encoding: 'base64' } },
			signal,
		)
		if (!res.ok || typeof res.content !== 'string') {
			throw new Error(res.error ?? 'read-file: no content')
		}
		return Buffer.from(res.content, 'base64')
	}

	/**
	 * One bounded slice, in one round trip.
	 *
	 * The guest's own ceiling on a range (`NAMZU_AGENT_READ_FILE_RANGE_BYTES`,
	 * 1 MiB by default) is not mirrored here and deliberately so: it is the
	 * DEPLOYMENT's number, a host that guessed it would refuse ranges the
	 * guest would have served, and the guest's refusal already names the
	 * variable that raises it.
	 */
	private async readFileRange(
		path: string,
		offset: number,
		length: number,
		signal?: AbortSignal,
	): Promise<Buffer> {
		const res = await this.request<ReadFileResponse>(
			{ op: 'read-file', body: { path, encoding: 'base64', offset, length } },
			signal,
		)
		if (!res.ok || typeof res.content !== 'string') {
			throw new Error(res.error ?? 'read-file: no content')
		}
		return Buffer.from(res.content, 'base64')
	}

	/**
	 * Read a file as an ordered sequence of chunks, so neither side holds
	 * the whole of it.
	 *
	 * The guest sends `meta`, then `data` frames, then `end`, then the
	 * zero-length terminator — the same terminated-stream shape `execute`
	 * uses. Two bounds keep this side's heap flat while the guest's stays
	 * flat on its own: the socket is PAUSED once
	 * {@link READ_FILE_STREAM_HIGH_WATER_BYTES} of decoded chunks are
	 * waiting for a slow consumer, and the guest itself waits for each
	 * `data` frame to drain before it reads the next one.
	 *
	 * Leaving the loop early — `break`, an exception, an aborted
	 * `options.signal` — destroys the socket in the generator's `finally`,
	 * which is what makes the guest close its fd: it sees the connection go
	 * and releases the descriptor rather than leaking one per abandoned
	 * read.
	 *
	 * Refuses a guest that does not advertise
	 * {@link READ_FILE_STREAM_FEATURE} before dialing, with
	 * {@link AgentReadFileStreamUnsupportedError}.
	 */
	readFileStream(
		path: string,
		options?: SandboxReadFileOptions,
	): AsyncGenerator<Buffer, void, undefined> {
		return this.readFileFrames(path, options)
	}

	/**
	 * The stream itself. Private, and one argument wider than
	 * {@link readFileStream}: `onMeta` fires once, with the guest's `meta`
	 * frame, before the first chunk is yielded, which is how
	 * {@link readFile} sizes its destination buffer without a second round
	 * trip and without a public parameter nobody outside this class should
	 * pass.
	 */
	private async *readFileFrames(
		path: string,
		options?: SandboxReadFileOptions,
		onMeta?: (meta: { sizeBytes: number; offset: number; length: number }) => void,
	): AsyncGenerator<Buffer, void, undefined> {
		const signal = options?.signal
		signal?.throwIfAborted()
		if (!(await this.guestSupportsReadFileStream(signal))) {
			throw new AgentReadFileStreamUnsupportedError(
				`read-file-stream: this guest does not advertise the '${READ_FILE_STREAM_FEATURE}' healthz feature, so it has no streamed read at all. Rebuild the guest image from this Namzu release, or use readFile for a file small enough to cross the wire in one frame.`,
			)
		}
		const body: ReadFileStreamRequest = {
			path,
			...(options?.offset !== undefined ? { offset: options.offset } : {}),
			...(options?.length !== undefined ? { length: options.length } : {}),
		}
		const payload = JSON.stringify(
			this.withCredential({ op: 'read-file-stream', body } satisfies AgentRequest),
		)
		this.assertPreauthBudget(payload)
		const socket = await this.dial(signal)

		const queue: Buffer[] = []
		let queuedBytes = 0
		let paused = false
		let ended = false
		let failure: Error | undefined
		let meta: { sizeBytes: number; offset: number; length: number } | undefined
		let received = 0
		let declared: number | undefined
		let wake: (() => void) | undefined
		const notify = (): void => {
			const resume = wake
			wake = undefined
			resume?.()
		}
		const fail = (error: Error): void => {
			if (failure || ended) return
			failure = error
			notify()
		}
		const idle = new IdleTimer(this.readIdleTimeoutMs, () =>
			fail(
				new Error(
					`vsock transport: read-file-stream idle timeout after ${this.readIdleTimeoutMs}ms`,
				),
			),
		)
		const reader = new FrameReader()
		let terminated = false

		const onAbort = (): void => fail(signalError(signal))
		socket.on('data', (chunk: Buffer) => {
			// Once this read has failed — an abort, an idle timeout, a frame
			// the guest should not have sent — nothing more will be yielded,
			// so decoding what is still in flight only grows a queue no
			// consumer will ever pull from.
			if (failure) return
			idle.bump()
			let frames: string[]
			try {
				frames = reader.push(chunk)
			} catch (err) {
				fail(err instanceof Error ? err : new Error(String(err)))
				return
			}
			for (const frameBody of frames) {
				if (terminated) {
					fail(new Error('vsock transport: read-file-stream emitted data after its terminator'))
					return
				}
				if (frameBody.length === 0) {
					terminated = true
					continue
				}
				let event: ReadFileStreamEvent
				try {
					event = JSON.parse(frameBody) as ReadFileStreamEvent
				} catch (err) {
					fail(err instanceof Error ? err : new Error(String(err)))
					return
				}
				if (event.type === 'meta') {
					if (meta !== undefined) {
						fail(new Error('vsock transport: read-file-stream sent a second meta frame'))
						return
					}
					meta = { sizeBytes: event.sizeBytes, offset: event.offset, length: event.length }
					declared = event.length
					try {
						onMeta?.(meta)
					} catch (err) {
						fail(err instanceof Error ? err : new Error(String(err)))
						return
					}
					continue
				}
				if (event.type === 'data') {
					if (meta === undefined) {
						fail(new Error('vsock transport: read-file-stream sent data before its meta frame'))
						return
					}
					const bytes = Buffer.from(event.data, 'base64')
					received += bytes.byteLength
					queue.push(bytes)
					queuedBytes += bytes.byteLength
					if (!paused && queuedBytes >= READ_FILE_STREAM_HIGH_WATER_BYTES) {
						paused = true
						socket.pause()
						// The idle timer guards a guest that went silent, and
						// while WE are the reason it is silent it would be
						// measuring the consumer instead. A host draining a
						// gigabyte onto slow storage must not have its stream
						// torn down for reading carefully.
						idle.clear()
					}
					notify()
					continue
				}
				if (event.type === 'end') {
					// The guest counts what it sent; this side counts what it
					// decoded. A mismatch is a lost or duplicated frame, and a
					// truncated file handed back as a whole one is exactly the
					// silent corruption a streamed read must not introduce.
					if (event.bytesSent !== received) {
						fail(
							new Error(
								`vsock transport: read-file-stream declared ${event.bytesSent} bytes and delivered ${received}`,
							),
						)
						return
					}
					if (declared !== undefined && received !== declared) {
						fail(
							new Error(
								`vsock transport: read-file-stream announced ${declared} bytes and delivered ${received}`,
							),
						)
						return
					}
					ended = true
					notify()
					continue
				}
				fail(new Error(event.error))
				return
			}
		})
		socket.once('error', (err) => fail(err))
		socket.once('close', () => {
			if (ended || failure) {
				notify()
				return
			}
			fail(new Error('vsock transport: read-file-stream socket closed before its end frame'))
		})
		if (signal?.aborted) fail(signalError(signal))
		else signal?.addEventListener('abort', onAbort, { once: true })

		try {
			socket.write(frame(payload))
			idle.bump()
			for (;;) {
				// Asked BEFORE the queue, not after it: an aborted read that
				// goes on handing its consumer up to a high-water mark of
				// already-decoded bytes before surfacing the rejection is not
				// the prompt refusal `signal` promises. `ended` is the other
				// way round — a finished stream owes the consumer every byte
				// that arrived, so the queue drains first.
				if (failure) throw failure
				const next = queue.shift()
				if (next !== undefined) {
					queuedBytes -= next.byteLength
					if (paused && queuedBytes < READ_FILE_STREAM_HIGH_WATER_BYTES) {
						paused = false
						socket.resume()
						// Asking for bytes again restarts the clock that
						// measures whether they come.
						idle.bump()
					}
					yield next
					continue
				}
				if (ended) return
				await new Promise<void>((resolve) => {
					wake = resolve
				})
			}
		} finally {
			idle.clear()
			signal?.removeEventListener('abort', onAbort)
			// Destroyed, never `end()`ed: the guest releases the file
			// descriptor when the connection goes, and a half-close would
			// leave it holding one for a read nobody is listening to.
			socket.destroy()
		}
	}

	/**
	 * Ask the guest whether it implements ranged and streamed reads.
	 * Cached for the transport's lifetime, exactly as
	 * {@link guestSupportsWriteFileParts} is, and for the same reason: a
	 * pod does not swap its agent binary while it is running.
	 */
	private async guestSupportsReadFileStream(signal?: AbortSignal): Promise<boolean> {
		return (await this.guestFeatures(signal)).includes(READ_FILE_STREAM_FEATURE)
	}

	/**
	 * Open a real PTY owned by the in-VM agent.
	 *
	 * Unlike `execute`, this keeps one framed connection open for the complete
	 * interactive lifetime: guest output and exit events flow toward the host,
	 * while input/resize/kill events flow back on the same ordered stream. The
	 * browser never reaches this transport directly; the runtime gateway owns
	 * the session and its authenticated WebSocket attachment.
	 */
	async openTerminal(options: OpenTerminalOptions & SessionTerminalOpen): Promise<TerminalSession> {
		return (await this.openSessionTerminal(options)).session
	}

	/**
	 * The same open, handing back the session's own handles as well as the
	 * `TerminalSession` — the offset to come back at, and the detach that
	 * ends the attachment without signalling the program.
	 *
	 * Exactly one code path serves both: a persistent terminal is not a
	 * second kind of terminal, it is the same stream with a different answer
	 * to "what does a closed connection mean".
	 */
	async openSessionTerminal(
		options: OpenTerminalOptions & SessionTerminalOpen,
	): Promise<AgentTerminalStream> {
		const request: TerminalOpenRequest = {
			...(options.command !== undefined ? { command: options.command } : {}),
			...(options.args !== undefined ? { args: options.args } : {}),
			...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
			...(options.env !== undefined ? { env: { ...options.env } } : {}),
			cols: options.size.cols,
			rows: options.size.rows,
			// Additive and optional: an agent that predates it ignores the
			// field and echoes nothing back, and nothing below arms.
			...(this.heartbeatMs !== undefined ? { heartbeatMs: this.heartbeatMs } : {}),
			// Equally additive, and only ever sent by a caller that checked
			// the guest advertises `sessions` — see `protocol.ts`.
			...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
			...(options.persistent !== undefined ? { persistent: options.persistent } : {}),
		}
		return await this.openTerminalStream(
			{ op: 'terminal', body: request },
			{ detachable: options.persistent === true },
		)
	}

	/**
	 * The framed, bidirectional stream behind every terminal this transport
	 * opens — the one the `terminal` op starts, and the one `attach-session`
	 * joins to a terminal that is already running.
	 *
	 * Parameterised rather than copied, because the two differ in exactly two
	 * places and everything else — the dial, the framing, the ready
	 * handshake, the read-idle timer that is cleared once a shell may
	 * legitimately go quiet, the heartbeat, the output buffering before the
	 * first listener, the kill grace — has to behave identically or a
	 * reattached terminal is a second terminal implementation with its own
	 * bugs. The two differences:
	 *
	 *  - **`detachable`.** For a connection-bound terminal a lost stream IS
	 *    the end of the program, and `exited` resolves with `exitCode: -1`
	 *    exactly as it always has. For a session attachment it is not: the
	 *    program is still running in the pod, so `exited` REJECTS with
	 *    {@link AgentSessionDetachedError} rather than reporting an exit that
	 *    did not happen. The rejection is pre-handled here so a caller that
	 *    only reads output cannot take the host process down with an
	 *    unhandled rejection.
	 *  - **the offsets.** A session stream's frames carry their place in the
	 *    guest's retained log, and {@link AgentTerminalStream.nextOffset} is
	 *    what a reattach resumes from. It is never computed from the decoded
	 *    text: a chunk that ends mid-character decodes wider than the bytes
	 *    it replaced.
	 */
	private async openTerminalStream(
		req: AgentRequest,
		init: { readonly detachable: boolean },
	): Promise<AgentTerminalStream> {
		const askedHeartbeatMs = this.heartbeatMs
		const openPayload = JSON.stringify(this.withCredential(req))
		this.assertPreauthBudget(openPayload)
		const socket = await this.dial()

		return await new Promise<AgentTerminalStream>((resolve, reject) => {
			const KILL_GRACE_MS = 5_000
			const reader = new FrameReader()
			const listeners = new Set<(chunk: string) => void>()
			const buffered: string[] = []
			let bufferedBytes = 0
			let ready = false
			let settled = false
			let killTimer: ReturnType<typeof setTimeout> | undefined
			let readyEvent: TerminalReadyEvent = { type: 'ready' }
			let nextOffset: number | undefined
			/** Armed only if the guest echoed the interval — see `protocol.ts`. */
			let liveness: StreamLiveness | undefined
			let resolveExit!: (event: { exitCode: number; signal?: number }) => void
			let rejectExit!: (error: unknown) => void
			const exited = new Promise<{ exitCode: number; signal?: number }>((done, fail) => {
				resolveExit = done
				rejectExit = fail
			})
			// See the header: a detachable stream's `exited` can reject, and
			// the caller may legitimately never look at it.
			if (init.detachable) void exited.catch(() => undefined)
			const idle = new IdleTimer(this.readIdleTimeoutMs, () => {
				finish(
					new Error(
						`vsock transport: terminal read idle timeout after ${this.readIdleTimeoutMs}ms`,
					),
				)
			})

			const finish = (error: Error | null, exit?: { exitCode: number; signal?: number }) => {
				if (settled) return
				settled = true
				idle.clear()
				liveness?.stop()
				if (killTimer) clearTimeout(killTimer)
				socket.destroy()
				listeners.clear()
				if (exit !== undefined) resolveExit(exit)
				else if (init.detachable) {
					rejectExit(
						new AgentSessionDetachedError(
							nextOffset,
							`vsock transport: this attachment ended without the session's program exiting${
								error ? `: ${error.message}` : ''
							}. The program is still the guest's to run; attach again to go on reading it.`,
							{ cause: error ?? undefined },
						),
					)
				} else resolveExit({ exitCode: -1 })
				if (!ready) reject(error ?? new Error('terminal exited before readiness'))
			}

			const send = (event: TerminalInputEvent) => {
				if (settled) return
				socket.write(frame(JSON.stringify(event)))
			}

			const session: TerminalSession = {
				write(data) {
					send({ type: 'input', data })
				},
				resize(size) {
					send({ type: 'resize', cols: size.cols, rows: size.rows })
				},
				onData(listener) {
					listeners.add(listener)
					if (buffered.length > 0) {
						const pending = buffered.splice(0)
						bufferedBytes = 0
						queueMicrotask(() => {
							if (!listeners.has(listener)) return
							for (const chunk of pending) listener(chunk)
						})
					}
					return () => listeners.delete(listener)
				},
				exited,
				kill(signal) {
					send({ type: 'kill', ...(signal !== undefined ? { signal } : {}) })
					// A wedged guest must not pin sandbox.destroy() forever. The normal
					// path reports the real exit; the deadline only severs an
					// unresponsive transport so the owning microVM can be reclaimed.
					if (!settled && !killTimer) {
						killTimer = setTimeout(() => finish(null), KILL_GRACE_MS)
						killTimer.unref?.()
					}
				},
			}

			socket.on('data', (chunk: Buffer) => {
				if (!ready) idle.bump()
				// Bytes are proof of life, not only a heartbeat and not only a
				// whole frame: one large frame can take longer to arrive than the
				// window, and the peer was plainly there while it was arriving.
				liveness?.bump()
				let payloads: string[]
				try {
					payloads = reader.push(chunk)
				} catch (err) {
					finish(err instanceof Error ? err : new Error(String(err)))
					return
				}
				for (const payload of payloads) {
					// The guest ends a session stream with the same zero-length
					// terminator every other streamed op uses. Nothing follows it,
					// and the close below is what settles this stream.
					if (payload.length === 0) continue
					let event: TerminalOutputEvent
					try {
						event = JSON.parse(payload) as TerminalOutputEvent
					} catch (err) {
						finish(err instanceof Error ? err : new Error(String(err)))
						return
					}
					if (event.type === 'ready') {
						if (!ready) {
							ready = true
							readyEvent = event
							this.observeGuestReply(event)
							if (typeof event.nextOffset === 'number') nextOffset = event.nextOffset
							// Once ready, an interactive shell may legitimately sit silent
							// for hours. Runtime/session TTL owns idle cleanup; a transport
							// read timer would incorrectly kill a healthy quiet terminal.
							// The heartbeat below is what tells that shell from a peer
							// that vanished — armed only if the guest echoed an interval.
							idle.clear()
							const beat = negotiatedHeartbeatMs(askedHeartbeatMs, event.heartbeatMs)
							if (beat !== undefined) {
								liveness = new StreamLiveness(
									beat,
									() => send({ type: 'heartbeat' }),
									() =>
										finish(
											new Error(
												`vsock transport: terminal peer sent nothing for ${
													beat * STREAM_HEARTBEAT_MISS_LIMIT
												}ms and is treated as gone`,
											),
										),
								)
							}
							resolve({
								session,
								get ready() {
									return readyEvent
								},
								nextOffset: () => nextOffset,
								detach: () => finish(new Error('vsock transport: attachment released by the host')),
							})
						}
						continue
					}
					if (event.type === 'heartbeat') continue
					if (event.type === 'data') {
						if (typeof event.nextOffset === 'number') nextOffset = event.nextOffset
						if (listeners.size === 0) {
							buffered.push(event.data)
							bufferedBytes += Buffer.byteLength(event.data)
							while (bufferedBytes > 1024 * 1024 && buffered.length > 1) {
								bufferedBytes -= Buffer.byteLength(buffered.shift() ?? '')
							}
						} else {
							for (const listener of listeners) listener(event.data)
						}
						continue
					}
					if (event.type === 'exit') {
						if (typeof event.nextOffset === 'number') nextOffset = event.nextOffset
						finish(null, {
							exitCode: event.exitCode,
							...(event.signal !== undefined ? { signal: event.signal } : {}),
						})
						return
					}
					if (event.type === 'detached') {
						// The program did not exit: another attachment took the
						// session, or this one stopped draining. Either way this
						// stream ends and nothing in the guest was signalled.
						finish(new Error(`the guest ended this attachment (${event.reason})`))
						return
					}
					finish(new Error(event.error))
					return
				}
			})
			socket.once('error', (err) => finish(err))
			socket.once('close', () =>
				finish(new Error('vsock transport: terminal socket closed before exit')),
			)
			idle.bump()
			socket.write(frame(openPayload))
		})
	}

	/**
	 * Join a terminal session that is already running in the guest, replaying
	 * what it printed from `fromOffset` before following it live.
	 *
	 * The guest allows ONE attachment per session and ends the previous one
	 * by name, so two host processes cannot interleave keystrokes into one
	 * shell. Nothing here signals the program: releasing this stream is a
	 * detach, and ending the session is `kill-session`.
	 */
	async attachSessionTerminal(request: AttachSessionRequest): Promise<AgentTerminalStream> {
		return await this.openTerminalStream(
			{
				op: 'attach-session',
				body: {
					...request,
					...(this.heartbeatMs !== undefined ? { heartbeatMs: this.heartbeatMs } : {}),
				},
			},
			{ detachable: true },
		)
	}

	/** Open one TCP stream to a service listening on guest loopback. */
	async openTcpConnection(options: SandboxTcpConnectOptions): Promise<SandboxTcpConnection> {
		if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
			throw new Error('tcp connection port must be an integer in [1, 65535]')
		}
		const host = options.host ?? '127.0.0.1'
		if (host !== '127.0.0.1' && host !== '::1') {
			throw new Error('firecracker TCP connections are restricted to guest loopback')
		}
		const askedHeartbeatMs = this.heartbeatMs
		const request: TcpConnectRequest = {
			host,
			port: options.port,
			// Additive and optional, exactly as on `terminal` — see `openTerminal`.
			...(askedHeartbeatMs !== undefined ? { heartbeatMs: askedHeartbeatMs } : {}),
		}
		const openPayload = JSON.stringify(
			this.withCredential({ op: 'tcp-connect', body: request } satisfies AgentRequest),
		)
		this.assertPreauthBudget(openPayload)
		const socket = await this.dial()

		return await new Promise<SandboxTcpConnection>((resolve, reject) => {
			const reader = new FrameReader()
			const listeners = new Set<(chunk: Uint8Array) => void>()
			const buffered: Buffer[] = []
			let bufferedBytes = 0
			let ready = false
			let settled = false
			/** Armed only if the guest echoed the interval — see `protocol.ts`. */
			let liveness: StreamLiveness | undefined
			let resolveClosed!: () => void
			const closed = new Promise<void>((done) => {
				resolveClosed = done
			})
			const idle = new IdleTimer(this.readIdleTimeoutMs, () => {
				finish(
					new Error(`vsock transport: TCP connect idle timeout after ${this.readIdleTimeoutMs}ms`),
				)
			})

			const finish = (error: Error | null) => {
				if (settled) return
				settled = true
				idle.clear()
				liveness?.stop()
				socket.destroy()
				listeners.clear()
				resolveClosed()
				if (!ready) reject(error ?? new Error('TCP stream closed before readiness'))
			}

			const send = (event: TcpInputEvent): boolean => {
				return !settled && socket.write(frame(JSON.stringify(event)))
			}

			const connection: SandboxTcpConnection = {
				write(data) {
					const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data)
					return send({ type: 'data', data: bytes.toString('base64') })
				},
				end() {
					send({ type: 'end' })
				},
				destroy() {
					send({ type: 'destroy' })
					finish(null)
				},
				pause() {
					socket.pause()
					// Paused by this caller, so nothing arriving is this caller's
					// doing and not the peer's — see `StreamLiveness.suspend`.
					liveness?.suspend()
				},
				resume() {
					if (!settled) socket.resume()
					liveness?.resume()
				},
				onData(listener) {
					listeners.add(listener)
					if (buffered.length > 0) {
						const pending = buffered.splice(0)
						bufferedBytes = 0
						queueMicrotask(() => {
							if (!listeners.has(listener)) return
							for (const chunk of pending) listener(chunk)
						})
					}
					return () => listeners.delete(listener)
				},
				onDrain(listener) {
					socket.on('drain', listener)
					return () => socket.off('drain', listener)
				},
				closed,
			}

			socket.on('data', (chunk: Buffer) => {
				if (!ready) idle.bump()
				// Bytes, not frames — see the reader in `openTerminal` above.
				liveness?.bump()
				let payloads: string[]
				try {
					payloads = reader.push(chunk)
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)))
					return
				}
				for (const payload of payloads) {
					let event: TcpOutputEvent
					try {
						event = JSON.parse(payload) as TcpOutputEvent
					} catch (error) {
						finish(error instanceof Error ? error : new Error(String(error)))
						return
					}
					if (event.type === 'ready') {
						if (!ready) {
							ready = true
							this.observeGuestReply(event)
							idle.clear()
							const beat = negotiatedHeartbeatMs(askedHeartbeatMs, event.heartbeatMs)
							if (beat !== undefined) {
								liveness = new StreamLiveness(
									beat,
									() => {
										send({ type: 'heartbeat' })
									},
									() => finish(null),
								)
							}
							resolve(connection)
						}
						continue
					}
					if (event.type === 'heartbeat') continue
					if (event.type === 'data') {
						const bytes = Buffer.from(event.data, 'base64')
						if (listeners.size === 0) {
							buffered.push(bytes)
							bufferedBytes += bytes.byteLength
							while (bufferedBytes > 1024 * 1024 && buffered.length > 1) {
								bufferedBytes -= buffered.shift()?.byteLength ?? 0
							}
						} else {
							for (const listener of listeners) listener(bytes)
						}
						continue
					}
					if (event.type === 'end') {
						finish(null)
						continue
					}
					finish(new Error(event.error))
				}
			})
			socket.once('error', (error) => finish(error))
			socket.once('close', () =>
				finish(ready ? null : new Error('vsock TCP socket closed before readiness')),
			)
			idle.bump()
			socket.write(frame(openPayload))
		})
	}
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Reads exactly one `\n`-terminated line (used for the CONNECT ack). */
class LineReader {
	private buf: Buffer = Buffer.alloc(0)
	private remainder: Buffer = Buffer.alloc(0)

	push(chunk: Buffer): string | undefined {
		this.buf = Buffer.concat([this.buf, chunk])
		const nl = this.buf.indexOf(0x0a)
		if (nl < 0) return undefined
		const line = this.buf.subarray(0, nl).toString('utf8')
		this.remainder = Buffer.from(this.buf.subarray(nl + 1))
		return line
	}

	takeRemainder(): Buffer {
		const r = this.remainder
		this.remainder = Buffer.alloc(0)
		return r
	}
}

/**
 * The host half of the negotiated stream heartbeat (`protocol.ts`'s
 * `StreamHeartbeat`): send one every interval, and give up on a peer that
 * has sent nothing for {@link STREAM_HEARTBEAT_MISS_LIMIT} of them.
 *
 * Constructed only once the guest ECHOED an interval, so a transport that
 * asked for no heartbeat, or one talking to an agent that predates the
 * field, never builds one and writes no frame an older peer could not read.
 *
 * The watchdog polls at a quarter of the interval rather than at the
 * interval, so a dead stream is noticed within the three intervals plus at
 * most one poll tick rather than within four. Both timers are unref'd: a
 * host process with nothing else to do should exit, not be held open by a
 * terminal it forgot about.
 */
class StreamLiveness {
	private sendTimer: ReturnType<typeof setInterval> | undefined
	private watchTimer: ReturnType<typeof setInterval> | undefined
	private lastSeen = Date.now()
	private watching = true
	private stopped = false

	constructor(
		private readonly intervalMs: number,
		private readonly send: () => void,
		private readonly onDead: () => void,
	) {
		this.sendTimer = setInterval(() => {
			if (!this.stopped) this.send()
		}, intervalMs)
		this.sendTimer.unref?.()
		this.watchTimer = setInterval(() => this.check(), Math.max(10, Math.floor(intervalMs / 4)))
		this.watchTimer.unref?.()
	}

	/** Any BYTES from the peer count, not just a heartbeat and not a whole frame. */
	bump(): void {
		this.lastSeen = Date.now()
	}

	/**
	 * This side has paused reading for backpressure, so silence is its own
	 * doing and the peer's frames are waiting in the kernel. Not counted.
	 */
	suspend(): void {
		this.watching = false
	}

	resume(): void {
		if (this.stopped) return
		this.watching = true
		this.lastSeen = Date.now()
	}

	stop(): void {
		this.stopped = true
		if (this.sendTimer) clearInterval(this.sendTimer)
		if (this.watchTimer) clearInterval(this.watchTimer)
		this.sendTimer = undefined
		this.watchTimer = undefined
	}

	private check(): void {
		if (this.stopped || !this.watching) return
		if (Date.now() - this.lastSeen < this.intervalMs * STREAM_HEARTBEAT_MISS_LIMIT) return
		this.stop()
		this.onDead()
	}
}

/**
 * The interval the guest echoed back, or undefined when this side asked for
 * no heartbeat or the guest did not answer with one. An agent that predates
 * the field echoes nothing, which is exactly what keeps an older image's
 * streams behaving as they always did.
 *
 * The echo is clamped into `[MIN_STREAM_HEARTBEAT_MS, asked x
 * STREAM_HEARTBEAT_MAX_ECHO_FACTOR]`, because it is a number from the pod and
 * this side times its own watchdog with it. A guest that clamps to the same
 * floor — which is what this repository's agent does — always echoes a value
 * already inside the band, so nothing about the honest case changes.
 */
function negotiatedHeartbeatMs(asked: number | undefined, echoed: unknown): number | undefined {
	if (asked === undefined) return undefined
	if (typeof echoed !== 'number' || !Number.isFinite(echoed) || echoed <= 0) return undefined
	const ceiling = Math.max(asked, MIN_STREAM_HEARTBEAT_MS) * STREAM_HEARTBEAT_MAX_ECHO_FACTOR
	return Math.min(ceiling, Math.max(MIN_STREAM_HEARTBEAT_MS, Math.floor(echoed)))
}

/** Resets a timer on every byte; fires `onIdle` after `ms` of silence. */
class IdleTimer {
	private timer: NodeJS.Timeout | undefined
	constructor(
		private readonly ms: number,
		private readonly onIdle: () => void,
	) {}
	bump(): void {
		if (this.ms <= 0) return
		this.clear()
		this.timer = setTimeout(this.onIdle, this.ms)
		this.timer.unref()
	}
	clear(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
	}
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signalError(signal))
			return
		}
		const finish = (err?: unknown) => {
			clearTimeout(timer)
			signal?.removeEventListener('abort', abort)
			if (err === undefined) resolve()
			else reject(err)
		}
		const abort = () => finish(signalError(signal))
		const timer = setTimeout(() => finish(), ms)
		signal?.addEventListener('abort', abort, { once: true })
	})
}

/** Length of `n` raw bytes base64-encoded, padding included. Exact. */
function base64Length(n: number): number {
	return 4 * Math.ceil(n / 3)
}

/**
 * The temp file a part sequence for `target` writes into: a SIBLING of the
 * target, so the finishing `rename` is a within-directory rename on one
 * filesystem (atomic) rather than a cross-device copy, and so the path
 * passes the guest's workspace jail exactly as the target does.
 *
 * Split on `/` rather than through `node:path` because the path is the
 * GUEST's, which is always POSIX — a host running the orchestrator on
 * Windows must not rewrite it with backslashes. The target's own basename
 * rides along, truncated, so an operator who finds one of these knows what
 * it was becoming; the uuid is what makes two concurrent writers to the
 * same target use two different temp files.
 */
function writeFilePartTempPath(target: string): string {
	const slash = target.lastIndexOf('/')
	const dir = slash < 0 ? '' : target.slice(0, slash + 1)
	const base = (slash < 0 ? target : target.slice(slash + 1)).slice(0, 96)
	return `${dir}.namzu-write-${randomUUID()}-${base}.part`
}

function signalError(signal: AbortSignal | undefined): Error {
	if (signal?.reason instanceof Error) return signal.reason
	return new Error(signal?.reason === undefined ? 'operation aborted' : String(signal.reason))
}

function describeHandle(handle: SandboxAgentHandle): string {
	switch (handle.kind) {
		case 'unix':
			return `unix:${handle.path}`
		case 'vsock':
			return `vsock:${handle.udsPath}#${handle.port}`
		case 'mtls':
			return `mtls:${handle.host}:${handle.port}/${handle.sandboxId}`
		case 'tcp':
			// Never the token: this string lands in thrown error messages.
			return `tcp:${handle.host}:${handle.port}`
	}
}

// Internal framing helpers exported for the transport unit tests so the
// agent stand-in and the round-trip assertions share one framing impl.
export const __framing = { frame, FrameReader }
