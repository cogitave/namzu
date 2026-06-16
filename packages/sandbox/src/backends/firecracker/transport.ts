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

import type { SandboxExecResult } from '@namzu/sdk'
import {
	type ExecRequest,
	ExecResultAccumulator,
	type ReadFileRequest,
	type ReadFileResponse,
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
	| { readonly op: 'read-file'; readonly body: ReadFileRequest }
	| { readonly op: 'write-file'; readonly body: WriteFileRequest }
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
}

/**
 * The transport. One instance per sandbox handle; every request opens
 * a fresh connection (resume-survivable — no socket lingers across a
 * resume to be silently severed). All four ops + the heartbeat go
 * through {@link request} / {@link execute}.
 */
export class VsockAgentTransport {
	private readonly handle: SandboxAgentHandle
	private readonly connectTimeoutMs: number
	private readonly connectRetryBudgetMs: number
	private readonly connectRetryIntervalMs: number
	private readonly readIdleTimeoutMs: number

	constructor(handle: SandboxAgentHandle, options: VsockTransportOptions = {}) {
		this.handle = handle
		this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
		this.connectRetryBudgetMs = options.connectRetryBudgetMs ?? DEFAULT_CONNECT_RETRY_BUDGET_MS
		this.connectRetryIntervalMs =
			options.connectRetryIntervalMs ?? DEFAULT_CONNECT_RETRY_INTERVAL_MS
		this.readIdleTimeoutMs = options.readIdleTimeoutMs ?? DEFAULT_READ_IDLE_TIMEOUT_MS
	}

	/**
	 * Dial the agent with the resume-survival retry budget. Resolves a
	 * connected, post-handshake socket. Retries connect/handshake
	 * failures (ECONNREFUSED while the agent re-listens after a resume,
	 * a dropped CONNECT ack) until the budget is exhausted.
	 */
	private async dial(): Promise<net.Socket> {
		const deadline = Date.now() + this.connectRetryBudgetMs
		let lastErr: unknown
		for (;;) {
			try {
				return await this.connectOnce()
			} catch (err) {
				lastErr = err
				if (Date.now() >= deadline) break
				await delay(this.connectRetryIntervalMs)
			}
		}
		throw new Error(
			`vsock transport: could not connect to agent within ${this.connectRetryBudgetMs}ms (handle=${describeHandle(
				this.handle,
			)}): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
			{ cause: lastErr },
		)
	}

	private connectOnce(): Promise<net.Socket> {
		const handle = this.handle
		if (handle.kind === 'mtls') return this.connectOnceMtls(handle)
		return new Promise<net.Socket>((resolve, reject) => {
			const path = handle.kind === 'unix' ? handle.path : handle.udsPath
			const socket = net.connect({ path })
			let settled = false
			const timer = setTimeout(() => {
				if (settled) return
				settled = true
				socket.destroy()
				reject(new Error(`connect/handshake timed out after ${this.connectTimeoutMs}ms`))
			}, this.connectTimeoutMs)
			timer.unref()

			const fail = (err: Error) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				socket.destroy()
				reject(err)
			}

			socket.once('error', fail)

			socket.once('connect', () => {
				if (handle.kind === 'unix') {
					if (settled) return
					settled = true
					clearTimeout(timer)
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
			const timer = setTimeout(() => {
				if (settled) return
				settled = true
				socket.destroy()
				reject(new Error(`connect/handshake timed out after ${this.connectTimeoutMs}ms`))
			}, this.connectTimeoutMs)
			timer.unref()

			const fail = (err: Error) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				socket.destroy()
				reject(err)
			}

			socket.once('error', fail)

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
	async request<T>(req: AgentRequest): Promise<T> {
		const socket = await this.dial()
		return await new Promise<T>((resolve, reject) => {
			const reader = new FrameReader()
			let settled = false
			const idle = new IdleTimer(this.readIdleTimeoutMs, () => {
				if (settled) return
				settled = true
				socket.destroy()
				reject(new Error(`vsock transport: read idle timeout after ${this.readIdleTimeoutMs}ms`))
			})
			const finish = (err: Error | null, value?: T) => {
				if (settled) return
				settled = true
				idle.clear()
				socket.destroy()
				if (err) reject(err)
				else resolve(value as T)
			}
			socket.on('data', (chunk: Buffer) => {
				idle.bump()
				let frames: string[]
				try {
					frames = reader.push(chunk)
				} catch (err) {
					finish(err instanceof Error ? err : new Error(String(err)))
					return
				}
				const first = frames[0]
				if (first !== undefined) {
					try {
						finish(null, JSON.parse(first) as T)
					} catch (err) {
						finish(err instanceof Error ? err : new Error(String(err)))
					}
				}
			})
			socket.once('error', (err) => finish(err))
			socket.once('close', () => finish(new Error('vsock transport: socket closed before reply')))
			idle.bump()
			socket.write(frame(JSON.stringify(req)))
		})
	}

	/**
	 * Send an `/execute` and accumulate the streamed NDJSON frames into a
	 * {@link SandboxExecResult} via the shared {@link ExecResultAccumulator}.
	 * The agent terminates the stream with a zero-length frame.
	 */
	async execute(body: ExecRequest): Promise<SandboxExecResult> {
		const socket = await this.dial()
		const start = Date.now()
		return await new Promise<SandboxExecResult>((resolve, reject) => {
			const reader = new FrameReader()
			const acc = new ExecResultAccumulator(start)
			let settled = false
			const idle = new IdleTimer(this.readIdleTimeoutMs, () => {
				if (settled) return
				settled = true
				socket.destroy()
				reject(
					new Error(`vsock transport: exec read idle timeout after ${this.readIdleTimeoutMs}ms`),
				)
			})
			const finish = (err: Error | null, value?: SandboxExecResult) => {
				if (settled) return
				settled = true
				idle.clear()
				socket.destroy()
				if (err) reject(err)
				else resolve(value as SandboxExecResult)
			}
			socket.on('data', (chunk: Buffer) => {
				idle.bump()
				let frames: string[]
				try {
					frames = reader.push(chunk)
				} catch (err) {
					finish(err instanceof Error ? err : new Error(String(err)))
					return
				}
				for (const payload of frames) {
					if (payload.length === 0) {
						// Zero-length terminator. If a result was seen, we are
						// done; otherwise the stream ended without a result.
						finish(
							acc.done ? null : new Error('exec stream ended without a result event'),
							acc.finish(),
						)
						return
					}
					const event = parseExecLine(payload)
					if (!event) continue // malformed line — swallow (docker parity)
					try {
						if (acc.push(event)) {
							// Terminal result seen; wait for terminator but we can
							// resolve now — the agent closes after the terminator.
						}
					} catch (err) {
						finish(err instanceof Error ? err : new Error(String(err)))
						return
					}
				}
			})
			socket.once('error', (err) => finish(err))
			socket.once('close', () => {
				// Stream closed. If a result arrived, deliver it (some agents
				// close right after the terminator without a separate event);
				// otherwise it is a truncated stream.
				finish(
					acc.done ? null : new Error('vsock transport: socket closed before exec result'),
					acc.finish(),
				)
			})
			idle.bump()
			socket.write(frame(JSON.stringify({ op: 'execute', body } satisfies AgentRequest)))
		})
	}

	/** Liveness probe. Returns true on an `{ ok: true }` healthz reply. */
	async healthz(): Promise<boolean> {
		try {
			const res = await this.request<{ ok?: boolean }>({ op: 'healthz' })
			return res.ok === true
		} catch {
			return false
		}
	}

	/**
	 * Poll the agent until a healthz succeeds or the timeout elapses.
	 * Mirrors the HTTP `waitForWorkerReady`, but over the vsock dialer
	 * (which already carries connect retry) — used by the backend's
	 * post-create readiness fence.
	 */
	async waitForReady(timeoutMs: number, pollIntervalMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs
		let lastErr: unknown
		while (Date.now() < deadline) {
			try {
				if (await this.healthz()) return
				lastErr = new Error('healthz returned not-ok')
			} catch (err) {
				lastErr = err
			}
			await delay(pollIntervalMs)
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

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
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
