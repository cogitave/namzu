import type {
	MCPHttpSseTransportConfig,
	MCPJsonRpcMessage,
	MCPTransport,
} from '../../types/connector/index.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'

export class HttpSseTransport implements MCPTransport {
	private messageHandlers: Array<(message: MCPJsonRpcMessage) => void> = []
	private closeHandlers: Array<() => void> = []
	private errorHandlers: Array<(error: Error) => void> = []
	private connected = false
	private abortController: AbortController | null = null
	private sseUrl: string
	private postUrl: string
	private log: Logger

	constructor(private readonly config: MCPHttpSseTransportConfig) {
		const base = config.url.replace(/\/+$/, '')
		this.sseUrl = `${base}/sse`
		this.postUrl = `${base}/message`
		this.log = getRootLogger().child({ component: 'HttpSseTransport' })
	}

	async connect(): Promise<void> {
		if (this.connected) return

		this.abortController = new AbortController()
		await this.startSSE()
		this.connected = true
		this.log.info(`HttpSseTransport connected to ${this.config.url}`)
	}

	async close(): Promise<void> {
		this.connected = false
		this.abortController?.abort()
		this.abortController = null
		for (const handler of this.closeHandlers) handler()
	}

	async send(message: MCPJsonRpcMessage): Promise<void> {
		if (!this.connected) {
			throw new Error('HttpSseTransport: not connected')
		}

		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000)

		try {
			const response = await fetch(this.postUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...this.config.headers,
				},
				body: JSON.stringify(message),
				signal: controller.signal,
			})

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`)
			}

			const contentType = response.headers.get('content-type') ?? ''
			if (contentType.includes('application/json')) {
				const body = (await response.json()) as MCPJsonRpcMessage
				for (const handler of this.messageHandlers) handler(body)
			}
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

	private async startSSE(): Promise<void> {
		this.listenSSE().catch((err) => {
			if (this.connected) {
				this.log.error('SSE stream error', { error: String(err) })
				for (const handler of this.errorHandlers)
					handler(err instanceof Error ? err : new Error(String(err)))
			}
		})
	}

	private async listenSSE(): Promise<void> {
		const response = await fetch(this.sseUrl, {
			headers: {
				Accept: 'text/event-stream',
				...this.config.headers,
			},
			signal: this.abortController?.signal,
		})

		if (!response.ok || !response.body) {
			throw new Error(`SSE connection failed: HTTP ${response.status}`)
		}

		const reader = response.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ''

		while (this.connected) {
			const { done, value } = await reader.read()
			if (done) break

			buffer += decoder.decode(value, { stream: true })
			const events = buffer.split('\n\n')
			buffer = events.pop() ?? ''

			for (const event of events) {
				const dataLine = event.split('\n').find((line) => line.startsWith('data: '))
				if (!dataLine) continue
				const data = dataLine.slice(6)
				try {
					const message = JSON.parse(data) as MCPJsonRpcMessage
					for (const handler of this.messageHandlers) handler(message)
				} catch {
					this.log.warn(`HttpSseTransport: invalid SSE data: ${data.slice(0, 100)}`)
				}
			}
		}
	}
}
