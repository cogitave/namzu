import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

/**
 * A stand-in for `cua-driver.exe mcp`: a child process whose standard
 * streams speak newline-delimited JSON-RPC, scripted per test. It records
 * every message it receives and every signal it is sent.
 */

export interface ToolCall {
	readonly name: string
	readonly arguments: Record<string, unknown>
}

export type Reply =
	| { readonly result: unknown }
	| { readonly error: { readonly code: number; readonly message: string } }
	/** Never answer. */
	| { readonly hang: true }
	/** Exit with this code instead of answering. */
	| { readonly exit: number }

export interface FakeServerScript {
	/** Default: a normal initialize result. */
	readonly initialize?: (params: unknown) => Reply
	/** Default: `{ content: [], structuredContent: {} }`. */
	readonly tool?: (call: ToolCall, process: FakeMcpProcess) => Reply | Promise<Reply>
	/** Keep running when stdin closes (a server that ignores the polite stop). */
	readonly ignoreStdinEnd?: boolean
	/** Write lines in chunks of this many bytes, to exercise reassembly. */
	readonly chunkBytes?: number
}

export function toolResult(
	structuredContent: Record<string, unknown>,
	content: unknown[] = [],
): Reply {
	return { result: { content, structuredContent } }
}

export class FakeMcpProcess extends EventEmitter {
	readonly stdin = new PassThrough()
	readonly stdout = new PassThrough()
	readonly stderr = new PassThrough()
	readonly pid: number
	exitCode: number | null = null
	signalCode: NodeJS.Signals | null = null
	readonly received: Record<string, unknown>[] = []
	readonly signals: string[] = []
	private exited = false
	private buffer = ''

	constructor(
		private readonly script: FakeServerScript,
		pid = 4242,
	) {
		super()
		this.pid = pid
		this.stdin.setEncoding('utf8')
		this.stdin.on('data', (text: string) => {
			this.buffer += text
			let at = this.buffer.indexOf('\n')
			while (at !== -1) {
				const line = this.buffer.slice(0, at)
				this.buffer = this.buffer.slice(at + 1)
				void this.handle(line)
				at = this.buffer.indexOf('\n')
			}
		})
		this.stdin.on('end', () => {
			if (!this.script.ignoreStdinEnd) this.exit(0, null)
		})
	}

	get toolCalls(): ToolCall[] {
		return this.received
			.filter((message) => message.method === 'tools/call')
			.map((message) => message.params as ToolCall)
	}

	/** Write raw text to stdout, as a server would. */
	write(text: string): void {
		if (this.exited) return
		const chunk = this.script.chunkBytes
		if (!chunk) {
			this.stdout.write(text)
			return
		}
		const bytes = Buffer.from(text, 'utf8')
		for (let at = 0; at < bytes.length; at += chunk)
			this.stdout.write(bytes.subarray(at, at + chunk))
	}

	send(message: unknown): void {
		this.write(`${JSON.stringify(message)}\n`)
	}

	kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
		this.signals.push(String(signal))
		setImmediate(() => this.exit(null, typeof signal === 'string' ? signal : 'SIGKILL'))
		return true
	}

	/** End the process as a crash would. */
	crash(code = 3): void {
		this.stderr.write('boom: the driver fell over\n')
		setImmediate(() => this.exit(code, null))
	}

	exit(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.exited) return
		this.exited = true
		this.exitCode = code
		this.signalCode = signal
		this.stdout.end()
		this.stderr.end()
		this.emit('exit', code, signal)
		setImmediate(() => this.emit('close', code, signal))
	}

	private async handle(line: string): Promise<void> {
		if (line.trim().length === 0) return
		const message = JSON.parse(line) as Record<string, unknown>
		this.received.push(message)
		const id = message.id
		if (typeof message.method !== 'string' || id === undefined) return
		let reply: Reply
		if (message.method === 'initialize') {
			reply = this.script.initialize?.(message.params) ?? {
				result: {
					protocolVersion: '2025-06-18',
					capabilities: { tools: {} },
					serverInfo: { name: 'fake-cua-driver', version: '0.0.0' },
				},
			}
		} else if (message.method === 'tools/call') {
			reply = this.script.tool
				? await this.script.tool(message.params as ToolCall, this)
				: toolResult({})
		} else {
			reply = { error: { code: -32601, message: 'no such method' } }
		}
		if ('hang' in reply) return
		if ('exit' in reply) {
			this.exit(reply.exit, null)
			return
		}
		this.send({ jsonrpc: '2.0', id, ...reply })
	}
}

/** A `spawnProcess` that hands out fake processes in order and remembers them. */
export function fakeSpawner(script: FakeServerScript | ((index: number) => FakeServerScript)) {
	const processes: FakeMcpProcess[] = []
	const spawnProcess = (_command: string, _args: readonly string[]) => {
		const index = processes.length
		const child = new FakeMcpProcess(
			typeof script === 'function' ? script(index) : script,
			4242 + index,
		)
		processes.push(child)
		return child as unknown as ChildProcessWithoutNullStreams
	}
	return { processes, spawnProcess }
}

/** A minimal valid PNG header (signature + IHDR) of the given size; enough for dimension reads. */
export function pngHeader(width: number, height: number): Buffer {
	const buffer = Buffer.alloc(33)
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
	buffer.writeUInt32BE(13, 8)
	buffer.write('IHDR', 12, 'ascii')
	buffer.writeUInt32BE(width, 16)
	buffer.writeUInt32BE(height, 20)
	return buffer
}
