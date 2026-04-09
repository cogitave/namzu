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
		if (!this.process) return
		this.connected = false
		this.process.kill('SIGTERM')
		this.process = null
		this.buffer = ''
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
