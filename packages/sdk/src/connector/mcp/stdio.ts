import { type ChildProcess, spawn } from 'node:child_process'
import type {
	MCPJsonRpcMessage,
	MCPStdioTransportConfig,
	MCPTransport,
} from '../../types/connector/index.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'

export class StdioTransport implements MCPTransport {
	private process: ChildProcess | null = null
	private messageHandlers: Array<(message: MCPJsonRpcMessage) => void> = []
	private closeHandlers: Array<() => void> = []
	private errorHandlers: Array<(error: Error) => void> = []
	private connected = false
	/** True between kill and the process's own `close` event. */
	private exitPending = false
	private buffer = ''
	private log: Logger

	constructor(private readonly config: MCPStdioTransportConfig) {
		this.log = getRootLogger().child({ component: 'StdioTransport' })
	}

	async connect(): Promise<void> {
		if (this.connected) return

		this.process = spawn(this.config.command, this.config.args ?? [], {
			env: { ...process.env, ...this.config.env },
			cwd: this.config.cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
		})

		this.process.stdout?.on('data', (chunk: Buffer) => {
			this.buffer += chunk.toString('utf-8')
			this.processBuffer()
		})

		this.process.stderr?.on('data', (chunk: Buffer) => {
			this.log.warn(`MCP server stderr: ${chunk.toString('utf-8').trim()}`)
		})

		this.process.on('close', (code) => {
			this.connected = false
			this.log.info(`MCP server process exited with code ${code}`)
			for (const handler of this.closeHandlers) handler()
			// After the notification, not before it: this event is what tells
			// `MCPClient` the session ended.
			this.exitPending = false
			this.clearHandlers()
		})

		this.process.on('error', (err) => {
			this.connected = false
			for (const handler of this.errorHandlers) handler(err)
		})

		this.connected = true
		this.log.info(
			`StdioTransport connected: ${this.config.command} ${(this.config.args ?? []).join(' ')}`,
		)
	}

	async close(): Promise<void> {
		if (!this.process) {
			// Nothing was spawned, or the exit already ran. No `close` event is
			// coming, so this is the only chance to drop what `connect()`
			// registered — and without it a retry after a failed spawn stacks a
			// second set of handlers on the first.
			if (!this.exitPending) this.clearHandlers()
			return
		}
		this.connected = false
		this.exitPending = true
		this.process.kill('SIGTERM')
		this.process = null
		this.buffer = ''
		// The handlers deliberately survive this call. `process.on('close')`
		// fires them when the process actually exits, and dropping them here
		// would leave `MCPClient` believing it is still connected — so its next
		// `connect()` would be refused with "already connected".
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

	async send(message: MCPJsonRpcMessage): Promise<void> {
		if (!this.process?.stdin?.writable) {
			throw new Error('StdioTransport: not connected or stdin not writable')
		}
		const data = `${JSON.stringify(message)}\n`
		this.process.stdin.write(data)
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

	private processBuffer(): void {
		const lines = this.buffer.split('\n')
		this.buffer = lines.pop() ?? ''

		for (const line of lines) {
			const trimmed = line.trim()
			if (!trimmed) continue
			try {
				const message = JSON.parse(trimmed) as MCPJsonRpcMessage
				for (const handler of this.messageHandlers) handler(message)
			} catch {
				this.log.warn(`StdioTransport: invalid JSON-RPC message: ${trimmed.slice(0, 100)}`)
			}
		}
	}
}
