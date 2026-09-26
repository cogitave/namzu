import type {
	MCPFetchLike,
	MCPJsonRpcMessage,
	MCPStreamableHttpTransportConfig,
	MCPTransport,
	MCPTransportSendOptions,
} from '../../types/connector/index.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
import {
	ConnectorHttpOperation,
	readConnectorResponseBody,
	validateConnectorTimeoutMs,
} from '../http-operation.js'
import { MCPHttpStatusError } from './errors.js'
import { refuseMcpHttpRedirect } from './http-redirect.js'

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * How long a best-effort session teardown DELETE is given before this
 * transport stops tracking it.
 *
 * `close()` never awaits this at all — the bound exists only so a DELETE to
 * an unresponsive peer does not accumulate as a dangling request forever.
 */
const SESSION_DELETE_TIMEOUT_MS = 5_000
/** A subscription may live for hours; bound each event rather than its lifetime. */
const MAX_SUBSCRIPTION_EVENT_CHARS = 1_048_576
const MAX_SUBSCRIPTION_CHUNK_BYTES = 8_388_608
const MAX_SUBSCRIPTION_ERROR_BODY_BYTES = 65_536

export class StreamableHttpTransport implements MCPTransport {
	private messageHandlers: Array<(message: MCPJsonRpcMessage) => void> = []
	private closeHandlers: Array<() => void> = []
	private errorHandlers: Array<(error: Error) => void> = []
	private connected = false
	private sessionId: string | null = null
	/**
	 * The most recent SSE event `id` this transport has seen, if any.
	 *
	 * Legacy-only in effect, never in name: this transport only ever holds a
	 * `sessionId` on a legacy connection (a modern connection has no
	 * `initialize` reply to capture one from — `MCPClient` probes with
	 * `server/discover` instead), and {@link buildHeaders} sends
	 * `Last-Event-ID` only alongside a session id. Deliberately NOT cleared
	 * by `close()`: the whole point is arming the header for the request
	 * that follows a reconnect, once a fresh session exists to carry it.
	 */
	private lastEventId: string | null = null
	private generation = 0
	private activeSends = new Set<AbortController>()
	private log: Logger
	private readonly timeoutMs: number
	/** Defaults to the ambient global `fetch`; never read again once captured. */
	private readonly fetchImpl: MCPFetchLike

	constructor(
		private readonly config: MCPStreamableHttpTransportConfig,
		log?: Logger,
	) {
		this.timeoutMs = validateConnectorTimeoutMs(
			config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			'StreamableHttpTransport timeoutMs',
		)
		this.fetchImpl = config.fetch ?? fetch
		this.log = resolveLogger(log).child({ [SCOPE_ATTRIBUTE]: 'connector/mcp/streamable-http' })
	}

	async connect(): Promise<void> {
		if (this.connected) return
		this.generation++
		this.connected = true
		this.log.info('StreamableHttpTransport connected', { 'namzu.mcp.url': this.config.url })
	}

	async close(): Promise<void> {
		// Read and clear before anything else can observe or re-enter: whatever
		// happens below, this transport no longer believes it holds this session.
		const sessionId = this.sessionId
		this.sessionId = null

		if (!this.connected) {
			// Never connected, or already closed: nothing will notify, so this is
			// the only chance to drop what `connect()` registered before it failed.
			this.clearHandlers()
			if (sessionId) this.sendSessionDelete(sessionId)
			return
		}
		this.connected = false
		this.generation++
		const reason = new Error('StreamableHttpTransport closed')
		for (const controller of this.activeSends) controller.abort(reason)
		this.activeSends.clear()
		for (const handler of this.closeHandlers) handler()
		// After the notification, never before it.
		this.clearHandlers()
		if (sessionId) this.sendSessionDelete(sessionId)
	}

	/**
	 * Forget the session this transport has been attaching to requests,
	 * without otherwise disturbing the connection.
	 *
	 * Used by `MCPClient`'s legacy session-recovery path: a `404` on a
	 * request means the server has forgotten this session, and the spec's
	 * remedy is a fresh `initialize` sent with no session id attached — which
	 * only happens if this transport stops sending the stale one first.
	 */
	resetSession(): void {
		this.sessionId = null
	}

	/** Whether this transport is currently attaching a session id to its requests. */
	hasSession(): boolean {
		return this.sessionId !== null
	}

	/**
	 * Tell the peer this session is done, without making `close()` wait on
	 * the answer.
	 *
	 * A SHOULD, not a MUST: it lets a cooperative server free resources
	 * promptly instead of waiting out its own idle timeout, but a server that
	 * never hears it is no worse off than before this existed. Fire-and-forget
	 * on purpose — `close()`'s existing bounded-teardown guarantee must not
	 * grow a dependency on a round trip to a peer that may already be gone —
	 * and bounded by its own short timeout so a peer that never answers does
	 * not leave a request open indefinitely. A modern origin never reaches
	 * this: it never had a session id to send in the first place.
	 */
	private sendSessionDelete(sessionId: string): void {
		const controller = new AbortController()
		const timer = setTimeout(() => {
			controller.abort(new Error('MCP session DELETE timed out'))
		}, SESSION_DELETE_TIMEOUT_MS)
		timer.unref?.()
		const headers: Record<string, string> = {
			...this.config.headers,
			'Mcp-Session-Id': sessionId,
		}
		let sending: Promise<Response>
		try {
			sending = this.fetchImpl(this.config.url, {
				method: 'DELETE',
				headers,
				redirect: 'manual',
				signal: controller.signal,
			})
		} catch (err) {
			clearTimeout(timer)
			this.log.debug('Failed to send MCP legacy session DELETE', {
				'namzu.mcp.url': this.config.url,
				'exception.message': err instanceof Error ? err.message : String(err),
			})
			return
		}
		void sending
			.catch((err: unknown) => {
				this.log.debug('Failed to send MCP legacy session DELETE', {
					'namzu.mcp.url': this.config.url,
					'exception.message': err instanceof Error ? err.message : String(err),
				})
			})
			.finally(() => clearTimeout(timer))
	}

	/** See {@link StdioTransport} — the same append-only handler leak. */
	private clearHandlers(): void {
		this.messageHandlers = []
		this.closeHandlers = []
		this.errorHandlers = []
	}

	async send(message: MCPJsonRpcMessage, options?: MCPTransportSendOptions): Promise<void> {
		if (!this.connected) {
			throw new Error('StreamableHttpTransport: not connected')
		}

		const owned = this.beginSend(options?.signal)
		const operation = new ConnectorHttpOperation(
			owned.controller.signal,
			this.timeoutMs,
			'Streamable HTTP MCP send',
		)

		try {
			const response = await operation.run(() =>
				this.fetchImpl(this.config.url, {
					method: 'POST',
					headers: this.buildHeaders(options?.headers),
					body: JSON.stringify(message),
					redirect: 'manual',
					signal: operation.signal,
				}),
			)

			refuseMcpHttpRedirect(response, message.method)
			if (!response.ok) {
				throw new MCPHttpStatusError(
					'StreamableHttpTransport',
					response.status,
					response.statusText,
					await readErrorBody(response, operation),
				)
			}
			this.assertCurrent(owned.generation, operation)
			// MCP assigns the session during initialize. Letting an ordinary or
			// failed per-request response rotate it makes one bad cancellation
			// POST capable of poisoning every later request on this connection.
			if (message.method === 'initialize') this.captureSessionId(response)

			await this.dispatchResponseMessages(response, operation, owned.generation)
		} finally {
			// A streamable HTTP send owns one POST; its rejection is delivered to
			// that caller. It is not evidence that the logical MCP session died.
			// Raising onError here would let A's failed best-effort cancellation
			// reject every unrelated pending request B..N on the shared client.
			operation.close()
			owned.dispose()
		}
	}

	/**
	 * Modern MCP subscriptions are long-lived POST response streams. The ordinary
	 * `send` path reads a whole response under a request deadline, so using it
	 * here would buffer forever (or time out a healthy subscription). The client
	 * owns the initial acknowledgment deadline and this stream's abort signal.
	 */
	async sendSubscription(
		message: MCPJsonRpcMessage,
		options: MCPTransportSendOptions,
		onMessage?: (message: MCPJsonRpcMessage) => void,
	): Promise<void> {
		if (message.method !== 'subscriptions/listen' || message.id === undefined) {
			throw new Error('sendSubscription requires a subscriptions/listen request')
		}
		if (!this.connected) throw new Error('StreamableHttpTransport: not connected')
		const owned = this.beginSend(options.signal)
		try {
			const response = await this.fetchImpl(this.config.url, {
				method: 'POST',
				headers: this.buildHeaders(options.headers),
				body: JSON.stringify(message),
				redirect: 'manual',
				signal: owned.controller.signal,
			})
			refuseMcpHttpRedirect(response, message.method)
			if (!response.ok) {
				throw new MCPHttpStatusError(
					'StreamableHttpTransport',
					response.status,
					response.statusText,
					await readSubscriptionErrorBody(response, owned.controller.signal, this.timeoutMs),
				)
			}
			const mediaType = (response.headers.get('content-type') ?? '')
				.split(';', 1)[0]
				?.trim()
				.toLowerCase()
			if (mediaType !== 'text/event-stream' || !response.body) {
				throw new Error('MCP subscriptions/listen did not return an SSE response stream')
			}

			const reader = response.body.getReader()
			const decoder = new TextDecoder()
			let buffer = ''
			let previousChunkEndedWithCr = false
			const cancelReader = (): void => {
				void reader.cancel().catch(() => undefined)
			}
			owned.controller.signal.addEventListener('abort', cancelReader, { once: true })
			if (owned.controller.signal.aborted) cancelReader()
			try {
				while (this.connected && owned.generation === this.generation) {
					const { done, value } = await reader.read()
					if (done) break
					if (
						!this.connected ||
						owned.generation !== this.generation ||
						owned.controller.signal.aborted
					)
						break
					if (value.byteLength > MAX_SUBSCRIPTION_CHUNK_BYTES) {
						throw new Error('MCP subscription SSE chunk exceeds its size limit')
					}
					const oldLength = buffer.length
					let chunk = decoder.decode(value, { stream: true })
					// SSE permits LF, CRLF, and bare CR. A CRLF split across chunks
					// still counts as one line break, not an empty line.
					if (previousChunkEndedWithCr && chunk.startsWith('\n')) chunk = chunk.slice(1)
					previousChunkEndedWithCr = chunk.endsWith('\r')
					buffer += chunk.replace(/\r\n|\r/g, '\n')
					let searchFrom = Math.max(0, oldLength - 1)
					while (true) {
						const boundary = findSseEventBoundary(buffer, searchFrom)
						if (!boundary) break
						if (boundary.start > MAX_SUBSCRIPTION_EVENT_CHARS) {
							throw new Error('MCP subscription SSE event exceeds its size limit')
						}
						const event = buffer.slice(0, boundary.start)
						buffer = buffer.slice(boundary.end)
						searchFrom = 0
						for (const frame of parseSseMessages(event).messages) {
							if (
								!this.connected ||
								owned.generation !== this.generation ||
								owned.controller.signal.aborted
							)
								return
							if (onMessage) onMessage(frame)
							else for (const handler of [...this.messageHandlers]) handler(frame)
						}
					}
					if (buffer.length > MAX_SUBSCRIPTION_EVENT_CHARS) {
						throw new Error('MCP subscription SSE event exceeds its size limit')
					}
				}
				// A dangling partial event is not a notification. It cannot be
				// forwarded as a complete JSON-RPC frame when the stream closes.
			} finally {
				owned.controller.signal.removeEventListener('abort', cancelReader)
				cancelReader()
				reader.releaseLock()
			}
		} finally {
			owned.dispose()
		}
	}

	onMessage(handler: (message: MCPJsonRpcMessage) => void): void {
		this.messageHandlers.push(handler)
	}

	onClose(handler: () => void): void {
		this.closeHandlers.push(handler)
	}

	onError(handler: (error: Error) => void): void {
		this.errorHandlers.push(handler)
	}

	isConnected(): boolean {
		return this.connected
	}

	/**
	 * `extra` comes from `MCPTransportSendOptions.headers` — the client's
	 * per-send authority, `MCP-Protocol-Version` today — and is merged over
	 * this transport's own static config headers so a caller's value wins
	 * on a collision. `Mcp-Session-Id` is applied after both: it is
	 * transport-managed state a caller cannot see to conflict with.
	 */
	private buildHeaders(extra?: Readonly<Record<string, string>>): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			...this.config.headers,
			...extra,
		}

		if (this.sessionId) {
			headers['Mcp-Session-Id'] = this.sessionId
			// Resumption is a legacy-only concept, and gated the same way the
			// session id itself is: a modern connection never captures a
			// `sessionId` (see the field's own doc comment), so this branch is
			// unreachable there without a second, redundant era flag.
			if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId
		}

		return headers
	}

	private captureSessionId(response: Response): void {
		const sessionId =
			response.headers.get('mcp-session-id') ?? response.headers.get('Mcp-Session-Id')
		if (sessionId && sessionId.length > 0) {
			this.sessionId = sessionId
		}
	}

	private beginSend(signal: AbortSignal | undefined): {
		readonly controller: AbortController
		readonly generation: number
		dispose(): void
	} {
		signal?.throwIfAborted()
		const controller = new AbortController()
		const onAbort = (): void => controller.abort(signal?.reason)
		signal?.addEventListener('abort', onAbort, { once: true })
		if (signal?.aborted) onAbort()
		if (controller.signal.aborted) {
			signal?.removeEventListener('abort', onAbort)
			controller.signal.throwIfAborted()
		}
		this.activeSends.add(controller)
		return {
			controller,
			generation: this.generation,
			dispose: () => {
				signal?.removeEventListener('abort', onAbort)
				this.activeSends.delete(controller)
			},
		}
	}

	private assertCurrent(generation: number, operation: ConnectorHttpOperation): void {
		operation.throwIfStopped()
		if (!this.connected || generation !== this.generation) {
			throw new Error('Streamable HTTP MCP response belongs to a closed connection generation')
		}
	}

	private async dispatchResponseMessages(
		response: Response,
		operation: ConnectorHttpOperation,
		generation: number,
	): Promise<void> {
		const text = await operation.run(() => response.text())
		this.assertCurrent(generation, operation)
		if (text.trim().length === 0) return

		const contentType = response.headers.get('content-type') ?? ''
		const messages = contentType.includes('text/event-stream')
			? this.parseSseAndCaptureEventId(text)
			: parseJsonMessages(text)

		for (const message of messages) {
			this.assertCurrent(generation, operation)
			for (const handler of [...this.messageHandlers]) {
				this.assertCurrent(generation, operation)
				handler(message)
			}
		}
	}

	/**
	 * Parse an SSE body and remember the newest event `id` it carried, if
	 * any.
	 *
	 * The id survives past this one call — see the `lastEventId` field's own
	 * doc comment — so it is available to arm `Last-Event-ID` on whatever
	 * request follows a later reconnect.
	 */
	private parseSseAndCaptureEventId(raw: string): MCPJsonRpcMessage[] {
		const { messages, lastEventId } = parseSseMessages(raw)
		if (lastEventId !== undefined) this.lastEventId = lastEventId
		return messages
	}
}

/** Find an SSE blank line after line endings have been normalized to LF. */
function findSseEventBoundary(
	value: string,
	from: number,
): { start: number; end: number } | undefined {
	const start = value.indexOf('\n\n', from)
	return start < 0 ? undefined : { start, end: start + 2 }
}

/** Keep a rejected listen response useful for diagnosis without buffering an unbounded body. */
async function readSubscriptionErrorBody(
	response: Response,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<string> {
	const operation = new ConnectorHttpOperation(signal, timeoutMs, 'MCP subscription error body')
	try {
		const body = await readConnectorResponseBody(
			response,
			operation,
			MAX_SUBSCRIPTION_ERROR_BODY_BYTES,
		)
		return typeof body === 'string' ? body : (JSON.stringify(body) ?? '')
	} catch {
		// The status is still the answer when a peer sends an unreadable,
		// oversized, or stalled error body.
		return ''
	} finally {
		operation.close()
		void response.body?.cancel().catch(() => undefined)
	}
}

/**
 * The body of a failed response, or an empty string.
 *
 * Carried on the error rather than discarded, because a status alone cannot
 * tell a legacy origin from a modern one: a modern server answers an
 * unknown method with `404` and a JSON-RPC error body precisely so that a
 * client can tell the two apart. Reading it must never turn a clean HTTP
 * failure into a different one, so a body that cannot be read is simply
 * absent — the status error is the real answer either way.
 */
async function readErrorBody(
	response: Response,
	operation: ConnectorHttpOperation,
): Promise<string> {
	try {
		return await operation.run(() => response.text())
	} catch {
		return ''
	}
}

function parseJsonMessages(raw: string): MCPJsonRpcMessage[] {
	const parsed = JSON.parse(raw) as MCPJsonRpcMessage | MCPJsonRpcMessage[]
	return Array.isArray(parsed) ? parsed : [parsed]
}

/** What one SSE-formatted Streamable HTTP response body parsed into. */
export interface MCPSseParseResult {
	readonly messages: MCPJsonRpcMessage[]
	/**
	 * The value of the last `id:` field seen across every event in the body
	 * — including one whose `data:` was empty, SSE's own priming event.
	 * `undefined` when no event in the body carried an id at all.
	 */
	readonly lastEventId?: string
}

/**
 * Parse a response body served as `text/event-stream`.
 *
 * Exported and pure so it is a direct unit-test target, with no transport,
 * socket or server needed to see what it decides.
 *
 * Already correct on three counts before this: `data:` with or without a
 * leading space, multi-line data joined with `\n`, and the empty-data
 * priming event skipped as a message. This adds the two genuinely new
 * pieces — capturing `id:` (armed by the caller for a legacy
 * `Last-Event-ID` reconnect) and treating a `:`-prefixed comment or another
 * unrecognized line as exactly what the spec says it is: not a field, never
 * malformed input. Neither needed a special case: both filters below already
 * select a line by its OWN prefix and so already ignore anything else — a
 * comment, an `event:` line, a `retry:` line — without one.
 */
export function parseSseMessages(raw: string): MCPSseParseResult {
	const normalized = raw.replace(/\r\n/g, '\n')
	const events = normalized.split(/\n\n+/)
	const messages: MCPJsonRpcMessage[] = []
	let lastEventId: string | undefined

	for (const event of events) {
		const lines = event.split('\n')

		const idLines = lines
			.filter((line) => line.startsWith('id:'))
			.map((line) => line.slice('id:'.length).trim())
		// The LAST `id:` field within one event wins, per SSE's own
		// field-processing rules — relevant only for a malformed event that
		// repeats the field, but cheap to get right.
		if (idLines.length > 0) lastEventId = idLines.at(-1)

		const dataLines = lines
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice('data:'.length).trimStart())

		if (dataLines.length === 0) continue

		const data = dataLines.join('\n').trim()
		if (data.length === 0 || data === '[DONE]') continue

		const parsed = JSON.parse(data) as MCPJsonRpcMessage | MCPJsonRpcMessage[]
		if (Array.isArray(parsed)) {
			messages.push(...parsed)
		} else {
			messages.push(parsed)
		}
	}

	return lastEventId !== undefined ? { messages, lastEventId } : { messages }
}
