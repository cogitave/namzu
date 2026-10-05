/** One owned CLI process per project. The renderer never sees this transport. */
import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AcpInitializeResult } from '@namzu/sdk'
import {
	type DesktopDiagnosticContext,
	type DesktopDiagnosticEvent,
	type DesktopDiagnosticSink,
	desktopStderrDetails,
} from './diagnostics.js'
import { ExpectedRuntimeCloseError } from './expected-close.js'

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
	private readonly connection = randomUUID()
	private pals = false
	supportsPals(): boolean {
		return this.pals
	}
	private palComputerControl = false
	supportsPalComputerControl(): boolean {
		return this.palComputerControl
	}
	private promptAttachments = false
	private promptOptions = false
	private turnRetry = false
	private tasks = false
	supportsTasks(): boolean {
		return this.tasks
	}
	supportsTurnRetry(): boolean {
		return this.turnRetry
	}
	supportsPromptOptions(): boolean {
		return this.promptOptions
	}
	supportsPromptAttachments(): boolean {
		return this.promptAttachments
	}
	private child?: ChildProcessWithoutNullStreams
	private buffer = ''
	private sequence = 0
	private diagnostic = ''
	private stderrBuffer = ''
	private closed = false
	private expectedClose = false
	private processClosed = false
	private shutdown?: Promise<void>
	private readonly pending = new Map<
		number,
		{
			method: string
			resolve(value: unknown): void
			reject(error: Error): void
			timer?: ReturnType<typeof setTimeout>
		}
	>()
	constructor(
		readonly cwd: string,
		private readonly command: RuntimeCommand,
		private readonly diagnostics?: DesktopDiagnosticSink,
	) {
		super()
	}
	private report(event: DesktopDiagnosticEvent, context: DesktopDiagnosticContext = {}): void {
		try {
			this.diagnostics?.record(event, { ...context, connection: this.connection })
		} catch {
			/* A host diagnostic sink cannot break transport ownership. */
		}
	}
	private consumeStderr(text: string): void {
		this.diagnostic = (this.diagnostic + text).slice(-16_000)
		this.stderrBuffer += text
		let newline = this.stderrBuffer.indexOf('\n')
		while (newline !== -1) {
			const line = this.stderrBuffer.slice(0, newline).trim()
			this.stderrBuffer = this.stderrBuffer.slice(newline + 1)
			if (line)
				this.report('cli_stderr', { bytes: Buffer.byteLength(line), ...desktopStderrDetails(line) })
			newline = this.stderrBuffer.indexOf('\n')
		}
		if (this.stderrBuffer.length > 16_000) {
			this.report('cli_stderr', {
				bytes: Buffer.byteLength(this.stderrBuffer),
				...desktopStderrDetails(this.stderrBuffer.slice(0, 16_000)),
			})
			this.stderrBuffer = ''
		}
	}
	private flushStderr(): void {
		const line = this.stderrBuffer.trim()
		this.stderrBuffer = ''
		if (line)
			this.report('cli_stderr', { bytes: Buffer.byteLength(line), ...desktopStderrDetails(line) })
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
		this.report('cli_started')
		const decoder = new StringDecoder('utf8')
		child.stdout.on('data', (chunk: Buffer) => this.consume(decoder.write(chunk)))
		const stderrDecoder = new StringDecoder('utf8')
		child.stderr.on('data', (chunk: Buffer) => this.consumeStderr(stderrDecoder.write(chunk)))
		let stderrEnded = false
		const finishStderr = () => {
			if (stderrEnded) return
			stderrEnded = true
			this.consumeStderr(stderrDecoder.end())
			this.flushStderr()
		}
		child.stderr.once('end', finishStderr)
		child.on('error', (error) => this.fail(error))
		child.on('close', (exitCode) => {
			finishStderr()
			this.processClosed = true
			this.report('cli_closed', { exitCode })
			this.fail(new Error('The Namzu connection closed. Reopen the project to reconnect.'))
		})
		const result = (await this.request(
			'initialize',
			{
				protocolVersion: 1,
				capabilities: ['permission', 'namzu/tasks'],
				clientInfo: { name: 'namzu-desktop', version: '0.1.0' },
			},
			30_000,
		)) as AcpInitializeResult
		this.promptAttachments = result.promptAttachments === true
		this.promptOptions = result.promptOptions === true
		this.tasks = result.extensions?.includes('namzu/tasks/list') === true
		this.turnRetry = ['namzu/sessions/retry-status', 'namzu/sessions/retry'].every((method) =>
			result.extensions?.includes(method),
		)
		this.pals = [
			'namzu/pals/list',
			'namzu/pals/get',
			'namzu/pals/create',
			'namzu/pals/update',
			'namzu/pals/conversations/list',
			'namzu/pals/conversations/claim',
			'namzu/pals/computer/status',
			'namzu/pals/computer/start',
			'namzu/pals/computer/stop',
			'namzu/pals/computer/screen',
		].every((method) => result.extensions?.includes(method))
		this.palComputerControl = [
			'namzu/pals/computer/take_over',
			'namzu/pals/computer/return_control',
			'namzu/pals/computer/input',
		].every((method) => result.extensions?.includes(method))
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
		const id = ++this.sequence
		if (this.closed || !this.child) {
			const error = this.expectedClose
				? new ExpectedRuntimeCloseError()
				: new Error('Namzu is not connected.')
			if (!this.expectedClose)
				this.report('cli_request_failed', { operation: method, request: id, error })
			return Promise.reject(error)
		}
		return new Promise((resolve, reject) => {
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							this.pending.delete(id)
							const error = new Error(
								'Namzu did not answer. Stop the operation or reopen this project.',
							)
							this.report('cli_request_failed', { operation: method, request: id, error })
							reject(error)
						}, timeoutMs)
					: undefined
			this.pending.set(id, { method, resolve, reject, timer })
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
							if (frame.error) {
								const error = new Error(
									String((frame.error as { message?: unknown }).message ?? 'Namzu request failed.'),
								)
								this.report('cli_request_failed', {
									operation: entry.method,
									request: frame.id,
									error,
									rpcCode:
										typeof (frame.error as { code?: unknown }).code === 'number'
											? (frame.error as { code: number }).code
											: undefined,
								})
								entry.reject(error)
							} else {
								if (
									entry.method === 'session/prompt' &&
									frame.result &&
									typeof frame.result === 'object' &&
									'stopReason' in frame.result &&
									frame.result.stopReason === 'error'
								)
									this.report('cli_turn_failed', {
										operation: entry.method,
										request: frame.id,
										reason: 'turn-failed',
									})
								const notice =
									frame.result && typeof frame.result === 'object' && 'notice' in frame.result
										? frame.result.notice
										: undefined
								if (typeof notice === 'string' && notice)
									this.report('cli_notice', {
										operation: entry.method,
										request: frame.id,
										error: notice,
									})
								entry.resolve(frame.result)
							}
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
	private fail(error: Error, expected = false): void {
		if (!this.closed && !expected) this.report('cli_transport_failed', { error })
		const failure = expected ? new ExpectedRuntimeCloseError() : error
		for (const [request, entry] of this.pending) {
			if (!expected) this.report('cli_request_failed', { operation: entry.method, request, error })
			clearTimeout(entry.timer)
			entry.reject(failure)
		}
		this.pending.clear()
		if (!this.closed) {
			this.closed = true
			this.emit('closed', error)
		}
	}
	close(): Promise<void> {
		if (this.shutdown) return this.shutdown
		if (!this.closed) this.expectedClose = true
		this.fail(new ExpectedRuntimeCloseError(), true)
		const child = this.child
		if (!child?.pid || this.processClosed) return Promise.resolve()
		const shutdown = new Promise<void>((resolve, reject) => {
			let kill: ReturnType<typeof setTimeout> | undefined
			const finish = () => {
				clearTimeout(terminate)
				clearTimeout(kill)
				resolve()
			}
			const terminate = setTimeout(() => {
				if (process.platform === 'win32') {
					// The npm launcher is a CMD parent. Killing only that wrapper
					// leaves ACP alive and its inherited protocol pipes open.
					// Never target a PID after our owned child has already exited.
					if (child.exitCode !== null || child.signalCode !== null) {
						child.off('close', finish)
						reject(new Error('Namzu exited while descendants retained its protocol pipes.'))
						return
					}
					const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
					execFile(
						taskkill,
						['/pid', String(child.pid), '/t', '/f'],
						{ windowsHide: true },
						(error) => {
							if (error && !this.processClosed) {
								child.off('close', finish)
								reject(new Error('Could not stop the owned Namzu process tree.', { cause: error }))
							}
						},
					)
					return
				}
				child.kill()
				kill = setTimeout(() => child.kill('SIGKILL'), 1_000)
				kill.unref()
			}, 5_000)
			terminate.unref()
			child.once('close', finish)
			child.stdin.end()
		})
		this.shutdown = shutdown.catch((error) => {
			// A failed OS tree stop must remain observable and retryable.
			this.shutdown = undefined
			this.report('shutdown_failed', { error })
			throw error
		})
		return this.shutdown
	}
}
