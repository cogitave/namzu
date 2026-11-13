/** One owned CLI process per project. The renderer never sees this transport. */
import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
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
import { OPTIONAL_EXTENSION_GROUPS, type OptionalExtensionGroup } from './extension-groups.js'
import type { HostLauncher, HostRun } from './host-launcher.js'
import { REQUIRED_EXTENSIONS, desktopInitializeParams } from './required-extensions.js'

const MAX_FRAME = 8 * 1024 * 1024
export interface RuntimeCommand {
	program: string
	args: string[]
	env?: NodeJS.ProcessEnv
	/** The app's own version, told to the host at initialize. Read from the app, never written here. */
	clientVersion?: string
	/**
	 * Chooses the engine at every start. When present, `program`, `args` and `env` above are only
	 * the defaults the launcher's spawn specification is laid over.
	 */
	launcher?: HostLauncher
}
export class RuntimeClient extends EventEmitter {
	private readonly connection = randomUUID()
	private pals = false
	supportsPals(): boolean {
		return this.pals
	}
	private palCommunication = false
	supportsPalCommunication(): boolean {
		return this.palCommunication
	}
	private palInboxStart = false
	supportsPalInboxStart(): boolean {
		return this.palInboxStart
	}
	private palComputerControl = false
	supportsPalComputerControl(): boolean {
		return this.palComputerControl
	}
	private promptAttachments = false
	private promptOptions = false
	private turnRetry = false
	private turnUndo = false
	private abandonPaused = false
	/** An older runtime cannot close a paused turn without repeating it. */
	supportsAbandonPaused(): boolean {
		return this.abandonPaused
	}
	private liveInput = false
	supportsLiveInput(): boolean {
		return this.liveInput
	}
	private conversationActions = false
	supportsConversationActions(): boolean {
		return this.conversationActions
	}
	private archivedConversations = false
	supportsArchivedConversations(): boolean {
		return this.archivedConversations
	}
	private projectUntrust = false
	/** An older runtime has no way to take a folder off the trust list. */
	supportsProjectUntrust(): boolean {
		return this.projectUntrust
	}
	private projectPr = false
	supportsProjectPr(): boolean {
		return this.projectPr
	}
	private projectGit = false
	supportsProjectGit(): boolean {
		return this.projectGit
	}
	private mcpServers = false
	/** A host that predates the tool server list answers neither of its methods. */
	supportsMcpServers(): boolean {
		return this.mcpServers
	}
	private hooksView = false
	/** A host that predates the hooks view does not list `namzu/hooks/list`. */
	supportsHooksView(): boolean {
		return this.hooksView
	}
	private conversationSearch = false
	supportsConversationSearch(): boolean {
		return this.conversationSearch
	}
	private projectChanges = false
	private providerSetup = false
	supportsProviderSetup(): boolean {
		return this.providerSetup
	}
	supportsProjectChanges(): boolean {
		return this.projectChanges
	}
	private terminals = false
	/** A host that predates host terminals answers none of the `namzu/terminal/*` methods. */
	supportsTerminals(): boolean {
		return this.terminals
	}
	private tasks = false
	supportsTasks(): boolean {
		return this.tasks
	}
	supportsTurnRetry(): boolean {
		return this.turnRetry
	}
	supportsTurnUndo(): boolean {
		return this.turnUndo
	}
	supportsPromptOptions(): boolean {
		return this.promptOptions
	}
	supportsPromptAttachments(): boolean {
		return this.promptAttachments
	}
	private child?: ChildProcessWithoutNullStreams
	/**
	 * The unfinished last line, kept as the chunks it arrived in. Joining them only when its newline
	 * arrives matters: searching a concatenated buffer flattens it on every chunk, which is quadratic
	 * in the frame size (a frame carrying a 3 MiB image arrives in about eighty chunks).
	 */
	private partial: string[] = []
	private partialLength = 0
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
			this.diagnostics?.record(event, {
				...context,
				connection: this.connection,
			})
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
				this.report('cli_stderr', {
					bytes: Buffer.byteLength(line),
					...desktopStderrDetails(line),
				})
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
			this.report('cli_stderr', {
				bytes: Buffer.byteLength(line),
				...desktopStderrDetails(line),
			})
	}
	/** True while a start on a fetched engine may be answered by another try: failures are held back. */
	private quiet = false
	private suppressed?: Error
	/** Which spawned process the handlers still speak for; a discarded attempt's are ignored. */
	private generation = 0
	private run?: HostRun
	/** Set once, when the live process ends, even if that is before the launcher handed over `run`. */
	private exitReport?: { unexpected: boolean }

	async start(): Promise<void> {
		if (this.child || this.closed) throw new Error('This connection cannot be started twice.')
		const launcher = this.command.launcher
		if (!launcher) return this.startOn(this.command)
		try {
			const run = await launcher.start(
				async (spec, info) => {
					await this.discardAttempt()
					this.quiet = info.retryable
					await this.startOn({ ...this.command, ...spec })
					this.quiet = false
				},
				// A folder that has gone, or a close the app asked for, is not the engine's fault.
				(error) => !(error instanceof ExpectedRuntimeCloseError) && existsSync(this.cwd),
			)
			this.run = run
			// A host that ended while the launcher was still recording its start is reported now.
			if (this.exitReport) run.exited(this.exitReport.unexpected)
		} catch (error) {
			this.quiet = false
			const held = this.suppressed
			this.suppressed = undefined
			if (held) this.emit('closed', held)
			throw error
		}
	}

	/** The live process ended: the launcher is told once, and whether the app asked for it. */
	private reportExit(): void {
		if (this.exitReport) return
		this.exitReport = { unexpected: !this.expectedClose }
		this.run?.exited(this.exitReport.unexpected)
	}

	/** Ends a failed attempt's process and forgets its state, so the connection can start afresh. */
	private async discardAttempt(): Promise<void> {
		const child = this.child
		if (!child) return
		this.generation++
		for (const entry of this.pending.values()) clearTimeout(entry.timer)
		this.pending.clear()
		this.child = undefined
		this.closed = false
		this.expectedClose = false
		this.processClosed = false
		this.shutdown = undefined
		this.partial = []
		this.partialLength = 0
		this.stderrBuffer = ''
		this.diagnostic = ''
		this.suppressed = undefined
		this.exitReport = undefined
		try {
			child.stdin.end()
			child.kill()
		} catch {
			// already gone
		}
	}

	private async startOn(command: RuntimeCommand): Promise<void> {
		const generation = ++this.generation
		const child = spawn(command.program, command.args, {
			cwd: this.cwd,
			env: command.env ?? process.env,
			stdio: 'pipe',
			shell: false,
			windowsHide: true,
		})
		this.child = child
		this.report('cli_started')
		const decoder = new StringDecoder('utf8')
		child.stdout.on('data', (chunk: Buffer) => {
			if (generation === this.generation) this.consume(decoder.write(chunk))
		})
		const stderrDecoder = new StringDecoder('utf8')
		child.stderr.on('data', (chunk: Buffer) => {
			if (generation === this.generation) this.consumeStderr(stderrDecoder.write(chunk))
		})
		let stderrEnded = false
		const finishStderr = () => {
			if (stderrEnded) return
			stderrEnded = true
			this.consumeStderr(stderrDecoder.end())
			this.flushStderr()
		}
		child.stderr.once('end', finishStderr)
		child.on('error', (error) => {
			if (generation !== this.generation) return
			this.fail(error)
			this.reportExit()
		})
		child.on('close', (exitCode) => {
			if (generation !== this.generation) return
			finishStderr()
			this.processClosed = true
			this.report('cli_closed', { exitCode })
			this.fail(new Error('The Namzu connection closed.'))
			this.reportExit()
		})
		const result = (await this.request(
			'initialize',
			desktopInitializeParams(command.clientVersion),
			30_000,
		)) as AcpInitializeResult
		this.promptAttachments = result.promptAttachments === true
		this.promptOptions = result.promptOptions === true
		const offers = (group: OptionalExtensionGroup): boolean =>
			OPTIONAL_EXTENSION_GROUPS[group].every((method) => result.extensions?.includes(method))
		this.tasks = offers('tasks')
		this.palCommunication = offers('palCommunication')
		this.conversationActions = offers('conversationActions')
		this.archivedConversations = offers('archivedConversations')
		this.terminals = offers('terminals')
		this.providerSetup = offers('providerSetup')
		this.projectGit = offers('projectGit')
		this.projectPr = offers('projectPr')
		this.mcpServers = offers('mcpServers')
		this.hooksView = offers('hooksView')
		this.conversationSearch = offers('conversationSearch')
		this.projectUntrust = offers('projectUntrust')
		this.projectChanges = offers('projectChanges')
		this.turnRetry = offers('turnRetry')
		this.abandonPaused = offers('abandonPaused')
		this.turnUndo = offers('turnUndo')
		this.liveInput = offers('liveInput')
		this.pals = offers('pals')
		this.palInboxStart = offers('palInboxStart')
		this.palComputerControl = offers('palComputerControl')
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
				this.report('cli_request_failed', {
					operation: method,
					request: id,
					error,
				})
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
							this.report('cli_request_failed', {
								operation: method,
								request: id,
								error,
							})
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
		if (this.partialLength + text.length > MAX_FRAME) {
			this.fail(
				new Error(
					'Namzu received more data than it could handle, so the connection was reset. Try again.',
				),
			)
			this.close()
			return
		}
		let rest = text
		let newline = rest.indexOf('\n')
		while (newline !== -1) {
			const line = (this.partial.join('') + rest.slice(0, newline)).trim()
			this.partial = []
			this.partialLength = 0
			rest = rest.slice(newline + 1)
			try {
				if (line) {
					const frame = JSON.parse(line) as Record<string, unknown>
					if (!frame || frame.jsonrpc !== '2.0')
						throw new Error(
							'Namzu got a reply it couldn’t read, so the connection was reset. Try again.',
						)
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
			newline = rest.indexOf('\n')
		}
		if (rest) {
			this.partial.push(rest)
			this.partialLength += rest.length
		}
	}
	private fail(error: Error, expected = false): void {
		if (!this.closed && !expected) this.report('cli_transport_failed', { error })
		const failure = expected ? new ExpectedRuntimeCloseError() : error
		for (const [request, entry] of this.pending) {
			if (!expected)
				this.report('cli_request_failed', {
					operation: entry.method,
					request,
					error,
				})
			clearTimeout(entry.timer)
			entry.reject(failure)
		}
		this.pending.clear()
		if (!this.closed) {
			this.closed = true
			// While a start may still be retried on another engine, nobody hears of the failure yet.
			if (this.quiet) this.suppressed = error
			else this.emit('closed', error)
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
						reject(
							new Error(
								'Namzu closed, but part of it kept running. Restart Namzu if this keeps happening.',
							),
						)
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
								reject(
									new Error(
										'Namzu couldn’t stop one of its background programs. Close Namzu and open it again.',
										{
											cause: error,
										},
									),
								)
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
