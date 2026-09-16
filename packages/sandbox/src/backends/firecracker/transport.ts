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
	type ExecRequest,
	ExecResultAccumulator,
	type ReadFileRequest,
	type ReadFileResponse,
	type TcpConnectRequest,
	type TcpInputEvent,
	type TcpOutputEvent,
	type TerminalInputEvent,
	type TerminalOpenRequest,
	type TerminalOutputEvent,
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
	| { readonly op: 'reserve-execution' }
	| {
			readonly op: 'cancel-execution'
			readonly body: { readonly executionId: string }
	  }
	| { readonly op: 'read-file'; readonly body: ReadFileRequest }
	| { readonly op: 'write-file'; readonly body: WriteFileRequest }
	| { readonly op: 'terminal'; readonly body: TerminalOpenRequest }
	| { readonly op: 'tcp-connect'; readonly body: TcpConnectRequest }
	| { readonly op: 'healthz' }
) &
	// Intersected, not repeated per arm: the credential is orthogonal to
	// the op, and every arm may carry it. Optional and additive, so a host
	// that writes no token speaks the wire it always did — see
	// {@link AgentRequestCredential}.
	AgentRequestCredential

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
	 * Fires once per successful dial with how long the connect took, in
	 * milliseconds. Never fires with the handle's `token` or any request
	 * content — a bare number. Used by callers that build their own
	 * `RemoteExecutionAdapter` on top of this transport (the kubernetes
	 * backend's `KubernetesAgentTransport`) to attribute wall time; the
	 * vsock/mtls/unix arms are free to ignore it.
	 */
	readonly onDial?: (durationMs: number) => void
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
	private readonly onDial?: (durationMs: number) => void
	private readonly maxWriteFileBytes: number
	private readonly writeFilePartBytes?: number
	/**
	 * What the guest answered when asked whether it can take a body in
	 * parts, cached for this handle's lifetime. A pod does not swap its
	 * agent binary while it is running, so the probe is asked once per
	 * transport and only when a body is actually too large for one frame —
	 * every write that fits pays nothing for it.
	 */
	private writeFilePartsSupported?: boolean
	private readonly executionController: RemoteExecutionController<
		Pick<ExecRequest, 'stdin' | 'maxOutputBytes'>
	>

	constructor(handle: SandboxAgentHandle, options: VsockTransportOptions = {}) {
		this.handle = handle
		this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
		this.connectRetryBudgetMs = options.connectRetryBudgetMs ?? DEFAULT_CONNECT_RETRY_BUDGET_MS
		this.connectRetryIntervalMs =
			options.connectRetryIntervalMs ?? DEFAULT_CONNECT_RETRY_INTERVAL_MS
		this.readIdleTimeoutMs = options.readIdleTimeoutMs ?? DEFAULT_READ_IDLE_TIMEOUT_MS
		this.onDial = options.onDial
		this.maxWriteFileBytes = options.maxWriteFileBytes ?? DEFAULT_MAX_WRITE_FILE_BYTES
		if (options.writeFilePartBytes !== undefined) {
			this.writeFilePartBytes = Math.max(1, Math.floor(options.writeFilePartBytes))
		}
		const adapter: RemoteExecutionAdapter<Pick<ExecRequest, 'stdin' | 'maxOutputBytes'>> = {
			label: 'framed microVM agent',
			reserve: async (signal) => await this.reserveExecution(signal),
			cancel: async (executionId, signal) => await this.cancelExecution(executionId, signal),
			execute: async (executionId, command, argv, opts, signal, context) =>
				await this.executeRaw(
					{
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
					},
					opts,
					signal,
				),
		}
		this.executionController = new RemoteExecutionController(adapter)
	}

	/**
	 * Dial the agent with the resume-survival retry budget. Resolves a
	 * connected, post-handshake socket. Retries connect/handshake
	 * failures (ECONNREFUSED while the agent re-listens after a resume,
	 * a dropped CONNECT ack) until the budget is exhausted.
	 */
	private async dial(signal?: AbortSignal): Promise<net.Socket> {
		const deadline = Date.now() + this.connectRetryBudgetMs
		const dialStartedAt = Date.now()
		let lastErr: unknown
		for (;;) {
			signal?.throwIfAborted()
			try {
				const socket = await this.connectOnce(signal)
				this.onDial?.(Date.now() - dialStartedAt)
				return socket
			} catch (err) {
				if (signal?.aborted) throw signal.reason
				lastErr = err
				if (Date.now() >= deadline) break
				await delay(this.connectRetryIntervalMs, signal)
			}
		}
		throw new Error(
			`vsock transport: could not connect to agent within ${this.connectRetryBudgetMs}ms (handle=${describeHandle(
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
	 * Send one framed request and read one framed JSON reply (file-IO +
	 * healthz). Applies the read-idle timeout so a post-resume hung read
	 * is torn down rather than wedging the caller.
	 */
	async request<T>(req: AgentRequest, signal?: AbortSignal): Promise<T> {
		const envelope = this.withCredential(req)
		const payload = JSON.stringify(envelope)
		this.assertPreauthBudget(payload)
		const socket = await this.dial(signal)
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
	): Promise<SandboxExecResult> {
		const envelope = this.withCredential({ op: 'execute', body } satisfies AgentRequest)
		const payload = JSON.stringify(envelope)
		this.assertPreauthBudget(payload)
		const socket = await this.dial(signal)
		const start = Date.now()
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
				if (terminated && terminalResult) finish(null, terminalResult)
				else finish(new Error('vsock transport: socket closed before exec stream terminator'))
			})
			if (signal?.aborted) {
				abort()
				return
			}
			signal?.addEventListener('abort', abort, { once: true })
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
		return await this.executionController.exec(
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
		return await this.executionController.exec(command, argv, opts)
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

	private async reserveExecution(signal: AbortSignal): Promise<unknown> {
		const response = await this.request<Record<string, unknown>>(
			{ op: 'reserve-execution' },
			signal,
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

	private async cancelExecution(executionId: string, signal: AbortSignal): Promise<unknown> {
		return await this.request<unknown>({ op: 'cancel-execution', body: { executionId } }, signal)
	}

	/** Readiness probe. A healthy guest must also speak the exact host protocol. */
	async healthz(signal?: AbortSignal): Promise<boolean> {
		try {
			const res = await this.request<{ ok?: boolean; protocolVersion?: unknown }>(
				{ op: 'healthz' },
				signal,
			)
			if (res.ok !== true) return false
			if (res.protocolVersion !== FIRECRACKER_AGENT_PROTOCOL_VERSION) {
				const actual =
					res.protocolVersion === undefined ? 'missing' : JSON.stringify(res.protocolVersion)
				throw new RemoteProtocolError(
					`Firecracker guest protocol version mismatch: expected ${FIRECRACKER_AGENT_PROTOCOL_VERSION}, received ${actual}. Rebuild the golden image from the same Namzu release.`,
				)
			}
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
		if (this.writeFilePartsSupported !== undefined) return this.writeFilePartsSupported
		const reply = await this.request<{ features?: unknown }>({ op: 'healthz' }, signal)
		const features = Array.isArray(reply.features) ? reply.features : []
		const supported = features.includes(WRITE_FILE_PARTS_FEATURE)
		this.writeFilePartsSupported = supported
		return supported
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

	async readFile(path: string): Promise<Buffer> {
		const res = await this.request<ReadFileResponse>({
			op: 'read-file',
			body: { path, encoding: 'base64' },
		})
		if (!res.ok || typeof res.content !== 'string') {
			throw new Error(res.error ?? 'read-file: no content')
		}
		return Buffer.from(res.content, 'base64')
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
	async openTerminal(options: OpenTerminalOptions): Promise<TerminalSession> {
		const request: TerminalOpenRequest = {
			...(options.command !== undefined ? { command: options.command } : {}),
			...(options.args !== undefined ? { args: options.args } : {}),
			...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
			...(options.env !== undefined ? { env: { ...options.env } } : {}),
			cols: options.size.cols,
			rows: options.size.rows,
		}
		const openPayload = JSON.stringify(
			this.withCredential({ op: 'terminal', body: request } satisfies AgentRequest),
		)
		this.assertPreauthBudget(openPayload)
		const socket = await this.dial()

		return await new Promise<TerminalSession>((resolve, reject) => {
			const KILL_GRACE_MS = 5_000
			const reader = new FrameReader()
			const listeners = new Set<(chunk: string) => void>()
			const buffered: string[] = []
			let bufferedBytes = 0
			let ready = false
			let settled = false
			let killTimer: ReturnType<typeof setTimeout> | undefined
			let resolveExit!: (event: { exitCode: number; signal?: number }) => void
			const exited = new Promise<{ exitCode: number; signal?: number }>((done) => {
				resolveExit = done
			})
			const idle = new IdleTimer(this.readIdleTimeoutMs, () => {
				finish(
					new Error(
						`vsock transport: terminal read idle timeout after ${this.readIdleTimeoutMs}ms`,
					),
				)
			})

			const finish = (
				error: Error | null,
				exit: { exitCode: number; signal?: number } = { exitCode: -1 },
			) => {
				if (settled) return
				settled = true
				idle.clear()
				if (killTimer) clearTimeout(killTimer)
				socket.destroy()
				listeners.clear()
				resolveExit(exit)
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
				let payloads: string[]
				try {
					payloads = reader.push(chunk)
				} catch (err) {
					finish(err instanceof Error ? err : new Error(String(err)))
					return
				}
				for (const payload of payloads) {
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
							// Once ready, an interactive shell may legitimately sit silent
							// for hours. Runtime/session TTL owns idle cleanup; a transport
							// read timer would incorrectly kill a healthy quiet terminal.
							idle.clear()
							resolve(session)
						}
						continue
					}
					if (event.type === 'data') {
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
						finish(null, {
							exitCode: event.exitCode,
							...(event.signal !== undefined ? { signal: event.signal } : {}),
						})
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

	/** Open one TCP stream to a service listening on guest loopback. */
	async openTcpConnection(options: SandboxTcpConnectOptions): Promise<SandboxTcpConnection> {
		if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
			throw new Error('tcp connection port must be an integer in [1, 65535]')
		}
		const host = options.host ?? '127.0.0.1'
		if (host !== '127.0.0.1' && host !== '::1') {
			throw new Error('firecracker TCP connections are restricted to guest loopback')
		}
		const request: TcpConnectRequest = { host, port: options.port }
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
				},
				resume() {
					if (!settled) socket.resume()
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
							idle.clear()
							resolve(connection)
						}
						continue
					}
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
