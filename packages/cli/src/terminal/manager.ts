import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import {
	type CreateRequest,
	TERMINAL_LIMITS,
	type TerminalAttachResult,
	type TerminalDataNotification,
	type TerminalExitNotification,
	type TerminalInfo,
	TerminalRequestError,
} from './protocol.js'
import {
	type HostPty,
	type HostPtyModule,
	buildPtyEnv,
	defaultShell,
	defaultTitle,
	descendantsOf,
	killProcessTree,
} from './pty.js'
import { OutputRing } from './ring.js'
import { HeadlessScreen } from './screen.js'

export type TerminalEvent =
	| { readonly type: 'data'; readonly params: TerminalDataNotification }
	| { readonly type: 'exit'; readonly params: TerminalExitNotification }

export interface TerminalManagerOptions {
	/** Resolves the binding; rejects with the kernel's refusal when it is absent or broken. */
	readonly loadPty: () => Promise<HostPtyModule>
	/** Where output and exits go. Must not throw. */
	readonly emit: (event: TerminalEvent) => void
	/** The project folder; a terminal may start here or below it. */
	readonly cwd: string
	readonly env?: NodeJS.ProcessEnv
	readonly platform?: NodeJS.Platform
	readonly now?: () => number
	/** Runs a function soon, after the output already queued. Output is coalesced between calls. */
	readonly defer?: (run: () => void) => void
	readonly timers?: {
		setTimeout(run: () => void, ms: number): unknown
		clearTimeout(handle: unknown): void
	}
	/** Grace before a polite stop becomes a forced one. */
	readonly killGraceMs?: number
	/** The processes below a pid, for the sweep after a terminal ends. Defaults to reading the system. */
	readonly descendants?: (pid: number) => Promise<number[]>
	/** Sends a signal to one process; defaults to `process.kill`. */
	readonly signalProcess?: (pid: number, signal: 'SIGKILL') => void
	readonly ringCapacity?: number
}

interface Terminal {
	readonly id: string
	readonly pty: HostPty
	readonly ring: OutputRing
	readonly screen: HeadlessScreen
	readonly viewers: Set<string>
	readonly createdAt: number
	readonly title: string
	readonly cwd: string
	readonly command: string
	readonly args: readonly string[]
	cols: number
	rows: number
	status: 'running' | 'exited'
	exitCode?: number
	signal?: number
	writer: string | null
	/** Output captured but not yet announced. */
	pending: string
	pendingStart: number
	scheduled: boolean
	sent: number
	acked: number
	paused: boolean
	killing: boolean
	exited: Promise<void>
	/** Resolves when the terminal has ended and what it left behind has been swept. */
	stopping?: Promise<void>
	settle: () => void
	exitTimer: unknown
}

/** Sessions, their output, their screens and their keyboards. */
export class TerminalManager {
	private readonly terminals = new Map<string, Terminal>()
	private readonly defer: (run: () => void) => void
	private readonly now: () => number
	private readonly platform: NodeJS.Platform
	private readonly env: NodeJS.ProcessEnv
	private readonly grace: number
	private readonly timers: NonNullable<TerminalManagerOptions['timers']>
	private pty: Promise<HostPtyModule> | undefined
	private closed = false

	constructor(private readonly options: TerminalManagerOptions) {
		this.defer = options.defer ?? ((run) => void setImmediate(run))
		this.now = options.now ?? Date.now
		this.platform = options.platform ?? process.platform
		this.env = options.env ?? process.env
		this.grace = options.killGraceMs ?? 1_500
		this.timers = options.timers ?? {
			setTimeout: (run, ms) => setTimeout(run, ms),
			clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
		}
	}

	/** Load the binding once. A failure is not cached, so installing it later takes effect. */
	private binding(): Promise<HostPtyModule> {
		if (!this.pty) {
			const attempt = this.options.loadPty()
			this.pty = attempt
			attempt.catch(() => {
				if (this.pty === attempt) this.pty = undefined
			})
		}
		return this.pty
	}

	async available(): Promise<{ available: true } | { available: false; reason: string }> {
		try {
			await this.binding()
			return { available: true }
		} catch (error) {
			return { available: false, reason: error instanceof Error ? error.message : String(error) }
		}
	}

	private resolveCwd(requested: string | undefined): string {
		const root = resolve(this.options.cwd)
		if (requested === undefined) return root
		if (!isAbsolute(requested))
			throw new TerminalRequestError('A terminal folder must be an absolute path.')
		const target = resolve(requested)
		const within = (path: string, base: string): boolean => {
			const fold = (value: string) => (this.platform === 'win32' ? value.toLowerCase() : value)
			const separator = this.platform === 'win32' ? '\\' : '/'
			return (
				fold(path) === fold(base) ||
				fold(path).startsWith(fold(base).replace(/[\\/]+$/u, '') + separator)
			)
		}
		const refusal = 'A terminal can start in this project folder or below it.'
		if (!within(target, root)) throw new TerminalRequestError(refusal)
		try {
			if (!statSync(target).isDirectory()) throw new Error('not a directory')
		} catch {
			throw new TerminalRequestError('That terminal folder does not exist.')
		}
		// A link inside the project that leads out of it is not below the project.
		try {
			if (!within(realpathSync(target), realpathSync(root))) throw new TerminalRequestError(refusal)
		} catch (error) {
			if (error instanceof TerminalRequestError) throw error
			throw new TerminalRequestError('That terminal folder does not exist.')
		}
		return target
	}

	async create(request: CreateRequest): Promise<TerminalInfo> {
		if (this.closed) throw new TerminalRequestError('The terminal host is closed.')
		this.prune()
		if (this.terminals.size >= TERMINAL_LIMITS.maxTerminals)
			throw new TerminalRequestError(
				`This project already has ${TERMINAL_LIMITS.maxTerminals} terminals; close one first.`,
			)
		const cwd = this.resolveCwd(request.cwd)
		const binding = await this.binding()
		if (this.closed) throw new TerminalRequestError('The terminal host is closed.')
		const command = request.command ?? defaultShell(this.env, this.platform)
		let pty: HostPty
		try {
			pty = binding.spawn(command, [...request.args], {
				name: 'xterm-256color',
				cols: request.cols,
				rows: request.rows,
				cwd,
				env: buildPtyEnv(this.env, request.env, this.platform),
			})
		} catch (error) {
			throw new TerminalRequestError(
				`Could not start ${defaultTitle(command)}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		let settle: () => void = () => undefined
		const exited = new Promise<void>((done) => {
			settle = done
		})
		const terminal: Terminal = {
			id: randomUUID(),
			pty,
			ring: new OutputRing(this.options.ringCapacity ?? TERMINAL_LIMITS.ringCapacity),
			screen: new HeadlessScreen(request.cols, request.rows, TERMINAL_LIMITS.screenScrollback),
			viewers: new Set(),
			createdAt: this.now(),
			title: request.title ?? defaultTitle(command),
			cwd,
			command,
			args: request.args,
			cols: request.cols,
			rows: request.rows,
			status: 'running',
			writer: null,
			pending: '',
			pendingStart: 0,
			scheduled: false,
			sent: 0,
			acked: 0,
			paused: false,
			killing: false,
			exited,
			settle,
			exitTimer: undefined,
		}
		this.terminals.set(terminal.id, terminal)
		pty.onData((data) => this.output(terminal, data))
		pty.onExit((event) => this.finish(terminal, event))
		return this.info(terminal)
	}

	private output(terminal: Terminal, data: string): void {
		if (data.length === 0) return
		const start = terminal.ring.end
		terminal.ring.append(data)
		terminal.screen.write(data)
		if (terminal.viewers.size === 0) {
			terminal.sent = terminal.ring.end
			terminal.acked = terminal.ring.end
			return
		}
		if (terminal.pending === '') terminal.pendingStart = start
		terminal.pending += data
		this.schedule(terminal)
	}

	private schedule(terminal: Terminal): void {
		if (terminal.scheduled) return
		terminal.scheduled = true
		this.defer(() => {
			terminal.scheduled = false
			this.flush(terminal)
		})
	}

	private flush(terminal: Terminal): void {
		const text = terminal.pending
		if (text === '') return
		let offset = terminal.pendingStart
		terminal.pending = ''
		for (let at = 0; at < text.length; ) {
			let end = Math.min(text.length, at + TERMINAL_LIMITS.maxChunk)
			// A chunk never ends between the halves of a surrogate pair.
			const last = text.charCodeAt(end - 1)
			if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1
			const data = text.slice(at, end)
			this.options.emit({ type: 'data', params: { terminalId: terminal.id, offset, data } })
			offset += data.length
			at = end
		}
		terminal.sent = offset
		this.applyFlow(terminal)
	}

	private applyFlow(terminal: Terminal): void {
		if (terminal.status !== 'running') return
		const outstanding = terminal.sent - terminal.acked
		if (!terminal.paused && terminal.viewers.size > 0 && outstanding > TERMINAL_LIMITS.flowHigh) {
			terminal.paused = true
			terminal.pty.pause()
		} else if (
			terminal.paused &&
			(terminal.viewers.size === 0 || outstanding < TERMINAL_LIMITS.flowLow)
		) {
			terminal.paused = false
			terminal.pty.resume()
		}
	}

	private finish(terminal: Terminal, event: { exitCode: number; signal?: number }): void {
		if (terminal.status === 'exited') return
		this.flush(terminal)
		terminal.status = 'exited'
		terminal.exitCode = event.exitCode
		if (event.signal !== undefined && event.signal !== 0) terminal.signal = event.signal
		terminal.writer = null
		terminal.paused = false
		if (terminal.exitTimer !== undefined) this.timers.clearTimeout(terminal.exitTimer)
		this.options.emit({
			type: 'exit',
			params: {
				terminalId: terminal.id,
				exitCode: event.exitCode,
				...(terminal.signal === undefined ? {} : { signal: terminal.signal }),
			},
		})
		terminal.settle()
	}

	private get(id: string): Terminal {
		const terminal = this.terminals.get(id)
		if (!terminal) throw new TerminalRequestError('That terminal is not open.')
		return terminal
	}

	private info(terminal: Terminal): TerminalInfo {
		return {
			id: terminal.id,
			pid: terminal.pty.pid > 0 ? terminal.pty.pid : 0,
			title: terminal.title,
			cwd: terminal.cwd,
			command: terminal.command,
			args: terminal.args,
			cols: terminal.cols,
			rows: terminal.rows,
			status: terminal.status,
			...(terminal.exitCode === undefined ? {} : { exitCode: terminal.exitCode }),
			...(terminal.signal === undefined ? {} : { signal: terminal.signal }),
			createdAt: terminal.createdAt,
			offset: terminal.ring.end,
			writerHeld: terminal.writer !== null,
		}
	}

	list(): TerminalInfo[] {
		return [...this.terminals.values()].map((terminal) => this.info(terminal))
	}

	/** Drop the oldest ended terminals once only ended ones are in the way. */
	private prune(): void {
		if (this.terminals.size < TERMINAL_LIMITS.maxTerminals) return
		for (const [id, terminal] of this.terminals) {
			if (terminal.status === 'exited' && terminal.viewers.size === 0) {
				this.dispose(id, terminal)
				return
			}
		}
	}

	private dispose(id: string, terminal: Terminal): void {
		this.terminals.delete(id)
		terminal.screen.dispose()
	}

	/**
	 * Register a view and give it what it needs to draw the terminal as it is.
	 *
	 * Synchronous on purpose: the view is registered and the replay computed in one
	 * turn, so no chunk can fall between them, and a notification can never reach the
	 * client ahead of the answer that tells it where the stream resumes.
	 */
	attach(request: {
		terminalId: string
		viewerId: string
		fromOffset?: number
		writer: boolean
		force: boolean
	}): TerminalAttachResult {
		const terminal = this.get(request.terminalId)
		if (request.writer && terminal.status === 'running') {
			if (terminal.writer !== null && terminal.writer !== request.viewerId && !request.force)
				throw new TerminalRequestError('Another view is typing in this terminal.')
		}
		const end = terminal.ring.end
		const replay = request.fromOffset === undefined ? null : terminal.ring.slice(request.fromOffset)
		let mode: 'replay' | 'snapshot'
		let screen = ''
		let start: number
		let data: string
		let truncated = false
		if (replay !== null && request.fromOffset !== undefined) {
			mode = 'replay'
			start = request.fromOffset
			data = replay
		} else {
			mode = 'snapshot'
			screen = terminal.screen.serialize(
				TERMINAL_LIMITS.snapshotScrollback,
				TERMINAL_LIMITS.maxScreen,
			)
			const parsed = terminal.screen.offset()
			const tail = terminal.ring.slice(parsed)
			if (tail === null) {
				// The emulator is further behind than the ring reaches; say so.
				truncated = true
				start = terminal.ring.start
				data = terminal.ring.slice(start) ?? ''
			} else {
				start = parsed
				data = tail
			}
		}
		terminal.viewers.add(request.viewerId)
		let writer = terminal.writer === request.viewerId
		if (request.writer && terminal.status === 'running') {
			terminal.writer = request.viewerId
			writer = true
		}
		// Everything up to `end` travels in this answer.
		terminal.sent = end
		terminal.acked = end
		terminal.pending = ''
		this.applyFlow(terminal)
		return { terminal: this.info(terminal), mode, screen, data, start, end, writer, truncated }
	}

	detach(request: { terminalId: string; viewerId: string }): void {
		const terminal = this.get(request.terminalId)
		terminal.viewers.delete(request.viewerId)
		if (terminal.writer === request.viewerId) terminal.writer = null
		if (terminal.viewers.size === 0) {
			terminal.pending = ''
			terminal.sent = terminal.ring.end
			terminal.acked = terminal.ring.end
		}
		this.applyFlow(terminal)
	}

	private requireWriter(terminal: Terminal, viewerId: string): void {
		if (terminal.status !== 'running') throw new TerminalRequestError('That terminal has ended.')
		if (terminal.writer !== viewerId)
			throw new TerminalRequestError('This view does not hold the keyboard for that terminal.')
	}

	write(request: { terminalId: string; viewerId: string; data: string }): void {
		const terminal = this.get(request.terminalId)
		this.requireWriter(terminal, request.viewerId)
		terminal.pty.write(request.data)
	}

	resize(request: { terminalId: string; viewerId: string; cols: number; rows: number }): void {
		const terminal = this.get(request.terminalId)
		this.requireWriter(terminal, request.viewerId)
		if (terminal.cols === request.cols && terminal.rows === request.rows) return
		terminal.pty.resize(request.cols, request.rows)
		terminal.screen.resize(request.cols, request.rows)
		terminal.cols = request.cols
		terminal.rows = request.rows
	}

	ack(request: { terminalId: string; offset: number }): void {
		const terminal = this.get(request.terminalId)
		terminal.acked = Math.max(terminal.acked, Math.min(request.offset, terminal.sent))
		this.applyFlow(terminal)
	}

	/** Start ending a terminal's whole process tree. Resolves when it has ended. */
	async kill(id: string): Promise<void> {
		const terminal = this.get(id)
		await this.stop(terminal)
	}

	private stop(terminal: Terminal): Promise<void> {
		if (terminal.status === 'exited') return Promise.resolve()
		if (!terminal.killing) {
			terminal.killing = true
			if (terminal.paused) {
				terminal.paused = false
				terminal.pty.resume()
			}
			terminal.stopping = this.begin(terminal)
		}
		return terminal.stopping ?? terminal.exited
	}

	/**
	 * Descendants are listed before the polite stop: a program that detached itself (`nohup`,
	 * `setsid`) is no longer in the terminal's process group, and once its parent ends it is
	 * reparented and cannot be found by walking down. What is left after the terminal has ended is
	 * killed.
	 */
	private async begin(terminal: Terminal): Promise<void> {
		const pid = terminal.pty.pid
		let leftovers: number[] = []
		if (this.platform !== 'win32' && pid > 0) {
			try {
				leftovers = await (this.options.descendants ?? descendantsOf)(pid)
			} catch {
				/* The sweep is best effort. */
			}
		}
		if (terminal.status === 'running') {
			killProcessTree(terminal.pty, this.platform === 'win32' ? 'SIGTERM' : 'SIGHUP', this.platform)
			terminal.exitTimer = this.timers.setTimeout(() => {
				if (terminal.status === 'running') killProcessTree(terminal.pty, 'SIGKILL', this.platform)
			}, this.grace)
		}
		await terminal.exited
		const signal = this.options.signalProcess ?? ((p, s) => process.kill(p, s))
		for (const survivor of leftovers) {
			try {
				signal(survivor, 'SIGKILL')
			} catch {
				/* Already gone. */
			}
		}
	}

	/** End the terminal if it is running and forget it. */
	async close(id: string): Promise<void> {
		const terminal = this.get(id)
		await this.stop(terminal)
		this.dispose(id, terminal)
	}

	/** Resolves once the terminal's screen has caught up with all output so far. */
	screenSettled(id: string): Promise<void> {
		return this.get(id).screen.settled()
	}

	/** The rendered rows right now, for tests and for agents that read the screen. */
	screenLines(id: string): string[] {
		return this.get(id).screen.lines()
	}

	/** End every terminal and wait for them. For the host's own shutdown. */
	async closeAll(): Promise<void> {
		this.closed = true
		let giveUp: unknown
		const patience = new Promise<void>((done) => {
			giveUp = this.timers.setTimeout(done, this.grace * 4)
		})
		await Promise.race([
			Promise.all([...this.terminals.values()].map((terminal) => this.stop(terminal))),
			patience,
		])
		this.timers.clearTimeout(giveUp)
		for (const [id, terminal] of this.terminals) this.dispose(id, terminal)
	}
}
