import type {
	MCPJsonRpcMessage,
	MCPStreamableHttpTransportConfig,
	MCPTransport,
	MCPTransportSendOptions,
} from '../../types/connector/index.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
import { ConnectorHttpOperation, validateConnectorTimeoutMs } from '../http-operation.js'

const DEFAULT_TIMEOUT_MS = 30_000

export class StreamableHttpTransport implements MCPTransport {
	private messageHandlers: Array<(message: MCPJsonRpcMessage) => void> = []
	private closeHandlers: Array<() => void> = []
	private errorHandlers: Array<(error: Error) => void> = []
	private connected = false
	private sessionId: string | null = null
	private generation = 0
	private activeSends = new Set<AbortController>()
	private log: Logger
	private readonly timeoutMs: number

	constructor(
		private readonly config: MCPStreamableHttpTransportConfig,
		log?: Logger,
	) {
		this.timeoutMs = validateConnectorTimeoutMs(
			config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			'StreamableHttpTransport timeoutMs',
		)
		this.log = resolveLogger(log).child({ [SCOPE_ATTRIBUTE]: 'connector/mcp/streamable-http' })
	}

	async connect(): Promise<void> {
		if (this.connected) return
		this.generation++
		this.connected = true
		this.log.info('StreamableHttpTransport connected', { 'namzu.mcp.url': this.config.url })
	}

	async close(): Promise<void> {
		if (!this.connected) {
			// Never connected, or already closed: nothing will notify, so this is
			// the only chance to drop what `connect()` registered before it failed.
			this.clearHandlers()
			this.sessionId = null
			return
		}
		this.connected = false
		this.generation++
		this.sessionId = null
		const reason = new Error('StreamableHttpTransport closed')
		for (const controller of this.activeSends) controller.abort(reason)
		this.activeSends.clear()
		for (const handler of this.closeHandlers) handler()
		// After the notification, never before it.
		this.clearHandlers()
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
				fetch(this.config.url, {
					method: 'POST',
					headers: this.buildHeaders(),
					body: JSON.stringify(message),
					signal: operation.signal,
				}),
			)

			if (!response.ok) {
				throw new Error(`StreamableHttpTransport: HTTP ${response.status}: ${response.statusText}`)
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

	private buildHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			...this.config.headers,
		}

		if (this.sessionId) {
			headers['Mcp-Session-Id'] = this.sessionId
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
			? parseSseMessages(text)
			: parseJsonMessages(text)

		for (const message of messages) {
			this.assertCurrent(generation, operation)
			for (const handler of [...this.messageHandlers]) {
				this.assertCurrent(generation, operation)
				handler(message)
			}
		}
	}
}

function parseJsonMessages(raw: string): MCPJsonRpcMessage[] {
	const parsed = JSON.parse(raw) as MCPJsonRpcMessage | MCPJsonRpcMessage[]
	return Array.isArray(parsed) ? parsed : [parsed]
}

function parseSseMessages(raw: string): MCPJsonRpcMessage[] {
	const normalized = raw.replace(/\r\n/g, '\n')
	const events = normalized.split(/\n\n+/)
	const messages: MCPJsonRpcMessage[] = []

	for (const event of events) {
		const dataLines = event
			.split('\n')
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

	return messages
}
