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
 * The WIRE shape of an agent handle as the orchestrator returns it. Identical
 * to {@link SandboxAgentHandle} EXCEPT the `mtls` arm omits the `tls` cert
 * block: the orchestrator returns only host/port/sandboxId, and the consumer
 * (Vandal host layer) merges the cert material in (see `normalizeHandle`)
 * before constructing the transport. The `unix`/`vsock` arms are unchanged
 * (they carry no cert material).
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
export type AgentRequest =
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
 * Incremental frame reader. Feed it socket chunks; it yields complete
 * payloads. A zero-length frame is the exec stream terminator and is
 * surfaced as an empty string so the caller can stop.
 */
class FrameReader {
	private buf: Buffer = Buffer.alloc(0)

	push(chunk: Buffer): string[] {
		this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk])
		const out: string[] = []
		for (;;) {
			const nl = this.buf.indexOf(0x0a) // '\n'
			if (nl < 0 || nl < LENGTH_PREFIX_HEX) {
				// Need at least the hex header + newline.
				if (nl >= 0 && nl < LENGTH_PREFIX_HEX) {
					throw new Error(`vsock transport: malformed frame header (newline at ${nl})`)
				}
				break
			}
			const header = this.buf.subarray(0, nl).toString('ascii')
			if (!/^[0-9a-fA-F]{8}$/.test(header)) {
				throw new Error(`vsock transport: invalid frame length header ${JSON.stringify(header)}`)
			}
			const len = Number.parseInt(header, 16)
			if (!Number.isInteger(len) || len < 0) {
				throw new Error(`vsock transport: invalid frame length header ${JSON.stringify(header)}`)
			}
			const start = nl + 1
			if (this.buf.length < start + len) break // incomplete payload
			const payload = this.buf.subarray(start, start + len).toString('utf8')
			this.buf = this.buf.subarray(start + len)
			out.push(payload)
		}
		return out
	}

	get bufferedBytes(): number {
		return this.buf.length
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
		let lastErr: unknown
		for (;;) {
			signal?.throwIfAborted()
			try {
				return await this.connectOnce(signal)
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
	 * Send one framed request and read one framed JSON reply (file-IO +
	 * healthz). Applies the read-idle timeout so a post-resume hung read
	 * is torn down rather than wedging the caller.
	 */
	async request<T>(req: AgentRequest, signal?: AbortSignal): Promise<T> {
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
			socket.write(frame(JSON.stringify(req)))
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
			socket.write(frame(JSON.stringify({ op: 'execute', body } satisfies AgentRequest)))
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

	async writeFile(path: string, content: Buffer): Promise<void> {
		const res = await this.request<WriteFileResponse>({
			op: 'write-file',
			body: { path, content: content.toString('base64'), encoding: 'base64' },
		})
		if (!res.ok) {
			throw new Error(res.error ?? 'write-file failed')
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
		const socket = await this.dial()
		const request: TerminalOpenRequest = {
			...(options.command !== undefined ? { command: options.command } : {}),
			...(options.args !== undefined ? { args: options.args } : {}),
			...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
			...(options.env !== undefined ? { env: { ...options.env } } : {}),
			cols: options.size.cols,
			rows: options.size.rows,
		}

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
			socket.write(
				frame(
					JSON.stringify({
						op: 'terminal',
						body: request,
					} satisfies AgentRequest),
				),
			)
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
		const socket = await this.dial()
		const request: TcpConnectRequest = { host, port: options.port }

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
			socket.write(
				frame(
					JSON.stringify({
						op: 'tcp-connect',
						body: request,
					} satisfies AgentRequest),
				),
			)
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
	}
}

// Internal framing helpers exported for the transport unit tests so the
// agent stand-in and the round-trip assertions share one framing impl.
export const __framing = { frame, FrameReader }
