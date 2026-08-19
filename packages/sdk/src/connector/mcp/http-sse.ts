import type {
	MCPHttpSseTransportConfig,
	MCPJsonRpcMessage,
	MCPTransport,
	MCPTransportSendOptions,
} from '../../types/connector/index.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
import { ConnectorHttpOperation, validateConnectorTimeoutMs } from '../http-operation.js'

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Trim trailing slashes without a regex.
 *
 * `/\/+$/` backtracks quadratically on a long run of slashes, and this
 * value crosses a trust boundary — a host-supplied endpoint on a shared
 * event loop. The scan is linear and says the same thing.
 */
function stripTrailingSlashes(value: string): string {
	let end = value.length
	while (end > 0 && value[end - 1] === '/') {
		end--
	}
	return value.slice(0, end)
}

export class HttpSseTransport implements MCPTransport {
	private messageHandlers: Array<(message: MCPJsonRpcMessage) => void> = []
	private closeHandlers: Array<() => void> = []
	private errorHandlers: Array<(error: Error) => void> = []
	private connected = false
	private abortController: AbortController | null = null
	private generation = 0
	private activeSends = new Set<AbortController>()
	private sseUrl: string
	private postUrl: string
	private log: Logger
	private readonly timeoutMs: number

	constructor(
		private readonly config: MCPHttpSseTransportConfig,
		log?: Logger,
	) {
		const base = stripTrailingSlashes(config.url)
		this.sseUrl = `${base}/sse`
		this.postUrl = `${base}/message`
		this.timeoutMs = validateConnectorTimeoutMs(
			config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			'HttpSseTransport timeoutMs',
		)
		this.log = resolveLogger(log).child({ [SCOPE_ATTRIBUTE]: 'connector/mcp/http-sse' })
	}

	async connect(): Promise<void> {
		if (this.connected) return

		this.abortController = new AbortController()
		const generation = ++this.generation
		this.connected = true
		await this.startSSE(generation, this.abortController.signal)
		this.log.info('HttpSseTransport connected', { 'namzu.mcp.url': this.config.url })
	}

	async close(): Promise<void> {
		this.connected = false
		this.generation++
		const reason = new Error('HttpSseTransport closed')
		for (const controller of this.activeSends) controller.abort(reason)
		this.activeSends.clear()
		this.abortController?.abort()
		this.abortController = null
		for (const handler of this.closeHandlers) handler()
		// After the notification, never before it.
		this.clearHandlers()
	}

	/**
	 * Drop every registered handler.
	 *
	 * `onMessage`/`onClose`/`onError` append, and `MCPClient.connect()` calls
	 * all three every time — and is reachable again after `disconnect()`. So
	 * without this each reconnect duplicated the set, and after n cycles one
	 * inbound message dispatched to n handlers, n-1 of them closures over dead
	 * sessions that kept their old client state alive.
	 */
	private clearHandlers(): void {
		this.messageHandlers = []
		this.closeHandlers = []
		this.errorHandlers = []
	}

	async send(message: MCPJsonRpcMessage, options?: MCPTransportSendOptions): Promise<void> {
		if (!this.connected) {
			throw new Error('HttpSseTransport: not connected')
		}

		const owned = this.beginSend(options?.signal)
		const operation = new ConnectorHttpOperation(
			owned.controller.signal,
			this.timeoutMs,
			'HTTP-SSE MCP send',
		)

		try {
			const response = await operation.run(() =>
				fetch(this.postUrl, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						...this.config.headers,
					},
					body: JSON.stringify(message),
					signal: operation.signal,
				}),
			)

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`)
			}

			const contentType = response.headers.get('content-type') ?? ''
			if (contentType.includes('application/json')) {
				const body = (await operation.run(() => response.json())) as MCPJsonRpcMessage
				this.assertCurrent(owned.generation, operation)
				for (const handler of [...this.messageHandlers]) {
					this.assertCurrent(owned.generation, operation)
					handler(body)
				}
			}
		} finally {
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
			throw new Error('HTTP-SSE MCP response belongs to a closed connection generation')
		}
	}

	private isCurrent(generation: number): boolean {
		return this.connected && generation === this.generation
	}

	private async startSSE(generation: number, signal: AbortSignal): Promise<void> {
		this.listenSSE(generation, signal).catch((err) => {
			if (this.connected && generation === this.generation) {
				this.log.error('SSE stream error', { 'exception.message': String(err) })
				for (const handler of this.errorHandlers)
					handler(err instanceof Error ? err : new Error(String(err)))
			}
		})
	}

	private async listenSSE(generation: number, signal: AbortSignal): Promise<void> {
		const response = await fetch(this.sseUrl, {
			headers: {
				Accept: 'text/event-stream',
				...this.config.headers,
			},
			signal,
		})

		if (!response.ok || !response.body) {
			throw new Error(`SSE connection failed: HTTP ${response.status}`)
		}

		const reader = response.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ''

		while (this.isCurrent(generation)) {
			const { done, value } = await reader.read()
			if (done) break
			if (!this.isCurrent(generation)) break

			buffer += decoder.decode(value, { stream: true })
			const events = buffer.split('\n\n')
			buffer = events.pop() ?? ''

			for (const event of events) {
				if (!this.isCurrent(generation)) return
				const dataLine = event.split('\n').find((line) => line.startsWith('data: '))
				if (!dataLine) continue
				const data = dataLine.slice(6)
				try {
					const message = JSON.parse(data) as MCPJsonRpcMessage
					for (const handler of [...this.messageHandlers]) {
						if (!this.isCurrent(generation)) return
						handler(message)
					}
				} catch {
					this.log.warn('HttpSseTransport: invalid SSE data', {
						'namzu.mcp.data_head': data.slice(0, 100),
					})
				}
			}
		}
	}
}
