/** One owned CLI process per project. The renderer never sees this transport. */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import type { AcpInitializeResult } from '@namzu/sdk'

const MAX_FRAME = 8 * 1024 * 1024
const REQUIRED_EXTENSIONS = [
	'namzu/project/status',
	'namzu/project/trust',
	'namzu/conversations/list',
	'namzu/conversations/history',
	'namzu/providers/status',
	'namzu/providers/select',
	'namzu/jobs/list',
	'namzu/jobs/read',
	'namzu/jobs/stop',
]
export interface RuntimeCommand {
	program: string
	args: string[]
	env?: NodeJS.ProcessEnv
}
export class RuntimeClient extends EventEmitter {
	private child?: ChildProcessWithoutNullStreams
	private buffer = ''
	private sequence = 0
	private diagnostic = ''
	private closed = false
	private shutdown?: Promise<void>
	private readonly pending = new Map<
		number,
		{
			resolve(value: unknown): void
			reject(error: Error): void
			timer?: ReturnType<typeof setTimeout>
		}
	>()
	constructor(
		readonly cwd: string,
		private readonly command: RuntimeCommand,
	) {
		super()
	}
	async start(): Promise<void> {
		if (this.child || this.closed) throw new Error('This connection cannot be started twice.')
		const child = spawn(this.command.program, this.command.args, {
			cwd: this.cwd,
			env: this.command.env ?? process.env,
			stdio: 'pipe',
			shell: false,
			windowsHide: true,
		})
		this.child = child
		const decoder = new StringDecoder('utf8')
		child.stdout.on('data', (chunk: Buffer) => this.consume(decoder.write(chunk)))
		child.stderr.on('data', (chunk: Buffer) => {
			this.diagnostic = (this.diagnostic + chunk.toString('utf8')).slice(-16_000)
		})
		child.on('error', (error) => this.fail(error))
		child.on('close', () =>
			this.fail(new Error('The Namzu connection closed. Reopen the project to reconnect.')),
		)
		const result = (await this.request(
			'initialize',
			{
				protocolVersion: 1,
				capabilities: ['permission'],
				clientInfo: { name: 'namzu-desktop', version: '0.1.0' },
			},
			30_000,
		)) as AcpInitializeResult
		if (
			result.agentInfo?.name !== 'namzu' ||
			!REQUIRED_EXTENSIONS.every((method) => result.extensions?.includes(method))
		) {
			this.close()
			throw new Error('Update Namzu to a version that supports the desktop application.')
		}
	}
	request(
		method: string,
		params: Record<string, unknown> = {},
		timeoutMs = 30_000,
	): Promise<unknown> {
		if (this.closed || !this.child) return Promise.reject(new Error('Namzu is not connected.'))
		const id = ++this.sequence
		return new Promise((resolve, reject) => {
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							this.pending.delete(id)
							reject(new Error('Namzu did not answer. Stop the operation or reopen this project.'))
						}, timeoutMs)
					: undefined
			this.pending.set(id, { resolve, reject, timer })
			this.write({ jsonrpc: '2.0', id, method, params })
		})
	}
	answer(id: string | number, result: unknown): void {
		this.write({ jsonrpc: '2.0', id, result })
	}
	private write(value: unknown): void {
		if (!this.child || this.closed) return
		this.child.stdin.write(`${JSON.stringify(value)}\n`, (error) => {
			if (error) this.fail(error)
		})
	}
	private consume(text: string): void {
		if (this.closed) return
		this.buffer += text
		if (this.buffer.length > MAX_FRAME) {
			this.fail(new Error('Namzu returned an oversized protocol frame.'))
			this.close()
			return
		}
		let newline = this.buffer.indexOf('\n')
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).trim()
			this.buffer = this.buffer.slice(newline + 1)
			try {
				if (line) {
					const frame = JSON.parse(line) as Record<string, unknown>
					if (!frame || frame.jsonrpc !== '2.0') throw new Error('Invalid Namzu protocol response.')
					if (typeof frame.method === 'string') this.emit('frame', frame)
					else if (typeof frame.id === 'number') {
						const entry = this.pending.get(frame.id)
						if (entry) {
							clearTimeout(entry.timer)
							this.pending.delete(frame.id)
							if (frame.error)
								entry.reject(
									new Error(
										String(
											(frame.error as { message?: unknown }).message ?? 'Namzu request failed.',
										),
									),
								)
							else entry.resolve(frame.result)
						}
					}
				}
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)))
				this.close()
				return
			}
			newline = this.buffer.indexOf('\n')
		}
	}
	private fail(error: Error): void {
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer)
			entry.reject(error)
		}
		this.pending.clear()
		if (!this.closed) {
			this.closed = true
			this.emit('closed', error)
		}
	}
	close(): Promise<void> {
		if (this.shutdown) return this.shutdown
		this.fail(new Error('The Namzu connection was closed.'))
		const child = this.child
		if (!child?.pid || child.exitCode !== null) return Promise.resolve()
		this.shutdown = new Promise<void>((resolve) => {
			let kill: ReturnType<typeof setTimeout> | undefined
			const terminate = setTimeout(() => {
				child.kill()
				kill = setTimeout(() => child.kill('SIGKILL'), 1_000)
				kill.unref()
			}, 5_000)
			terminate.unref()
			child.once('close', () => {
				clearTimeout(terminate)
				clearTimeout(kill)
				resolve()
			})
			child.stdin.end()
		})
		return this.shutdown
	}
}
