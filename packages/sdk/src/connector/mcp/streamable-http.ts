import type {
	MCPJsonRpcMessage,
	MCPStreamableHttpTransportConfig,
	MCPTransport,
} from '../../types/connector/index.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'

const DEFAULT_TIMEOUT_MS = 30_000

export class StreamableHttpTransport implements MCPTransport {
	private messageHandlers: Array<(message: MCPJsonRpcMessage) => void> = []
	private closeHandlers: Array<() => void> = []
	private errorHandlers: Array<(error: Error) => void> = []
	private connected = false
	private sessionId: string | null = null
	private log: Logger

	constructor(private readonly config: MCPStreamableHttpTransportConfig) {
		this.log = getRootLogger().child({ component: 'StreamableHttpTransport' })
	}

	async connect(): Promise<void> {
		if (this.connected) return
		this.connected = true
		this.log.info(`StreamableHttpTransport connected to ${this.config.url}`)
	}

	async close(): Promise<void> {
		if (!this.connected) return
		this.connected = false
		for (const handler of this.closeHandlers) handler()
	}

	async send(message: MCPJsonRpcMessage): Promise<void> {
		if (!this.connected) {
			throw new Error('StreamableHttpTransport: not connected')
		}

		const controller = new AbortController()
		const timeout = setTimeout(
			() => controller.abort(),
			this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		)

		try {
			const response = await fetch(this.config.url, {
				method: 'POST',
				headers: this.buildHeaders(message),
				body: JSON.stringify(message),
				signal: controller.signal,
			})

			this.captureSessionId(response)

			if (!response.ok) {
				throw new Error(`StreamableHttpTransport: HTTP ${response.status}: ${response.statusText}`)
			}

			await this.dispatchResponseMessages(response)
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			for (const handler of this.errorHandlers) handler(error)
			throw error
		} finally {
			clearTimeout(timeout)
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

	private buildHeaders(message: MCPJsonRpcMessage): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			...this.config.headers,
		}

		if (message.method) {
			headers['Mcp-Method'] = message.method
		}
		if (this.sessionId) {
			headers['Mcp-Session-Id'] = this.sessionId
		}

		const toolName =
			message.params && typeof message.params.name === 'string' ? message.params.name : undefined
		if (toolName && (message.method === 'tools/call' || message.method === 'prompts/get')) {
			headers['Mcp-Name'] = toolName
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

	private async dispatchResponseMessages(response: Response): Promise<void> {
		const text = await response.text()
		if (text.trim().length === 0) return

		const contentType = response.headers.get('content-type') ?? ''
		const messages = contentType.includes('text/event-stream')
			? parseSseMessages(text)
			: parseJsonMessages(text)

		for (const message of messages) {
			for (const handler of this.messageHandlers) handler(message)
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
