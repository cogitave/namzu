import { ATTR_INVERSE } from '../terminal/host/cell.js'
import { Frame } from '../terminal/host/frame.js'
import { DiffWriter } from '../terminal/host/writer.js'
import type { HostPtyModule } from '../terminal/pty.js'
import { InputRouter, type NavKey } from './input.js'
import { computeLayout } from './layout.js'
import type { Prefix } from './prefix.js'
import { ChildSession, type SessionSpec } from './session.js'
import { drawRule, drawSidebar, endedMessage } from './sidebar.js'

export interface HostInput {
	on(event: 'data', listener: (chunk: string | Buffer) => void): unknown
	off(event: 'data', listener: (chunk: string | Buffer) => void): unknown
	setEncoding?(encoding: BufferEncoding): unknown
	setRawMode?(raw: boolean): unknown
	resume?(): unknown
	pause?(): unknown
}

export interface HostOutput {
	write(data: string): unknown
	readonly columns: number
	readonly rows: number
	on(event: 'resize', listener: () => void): unknown
	off(event: 'resize', listener: () => void): unknown
}

/** Runs `run` after `ms`; the returned function cancels it. Injected so tests own the clock. */
export type Schedule = (run: () => void, ms: number) => () => void

export const realSchedule: Schedule = (run, ms) => {
	const timer = setTimeout(run, ms)
	return () => clearTimeout(timer)
}

export interface SpacesHostOptions {
	readonly input: HostInput
	readonly output: HostOutput
	readonly binding: HostPtyModule
	readonly spec: SessionSpec
	readonly label: string
	readonly prefix: Prefix
	readonly schedule?: Schedule
	/** How a session's whole process tree is ended; the default signals its process group. */
	readonly kill?: ConstructorParameters<typeof ChildSession>[4]
}

/** At most about 60 frames a second. */
const FRAME_MS = 16
/** How long a session gets to save itself after a hang-up before it is ended outright. */
const QUIT_GRACE_MS = 3000

const ENTER_SCREEN = '\x1b[?1049h\x1b[2J'
const LEAVE_SCREEN = '\x1b[?2004l\x1b[?25h\x1b[?1049l'

/**
 * The spaces shell: a sidebar and the selected session's screen in one terminal.
 *
 * It draws and routes keys and nothing else. Each session is a whole `namzu`
 * running in its own pseudo-terminal, so a session that crashes greys its row and
 * the rest keep running.
 */
export class SpacesHost {
	private readonly sessions: ChildSession[] = []
	private selected = 0
	private sidebarVisible = true
	private confirmingQuit = false
	private pasteOn = false
	private pending: (() => void) | undefined
	private rendering: Promise<void> = Promise.resolve()
	private closed = false
	private quitting = false
	private cancelKill: (() => void) | undefined
	private readonly router: InputRouter
	private readonly writer = new DiffWriter()
	private readonly schedule: Schedule
	private finish!: (code: number) => void
	/** Resolves with the exit code once the host has left the terminal alone. */
	readonly done: Promise<number> = new Promise((resolve) => {
		this.finish = resolve
	})

	private readonly onData = (chunk: string | Buffer): void =>
		this.handleInput(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
	private readonly onResize = (): void => this.relayout()

	constructor(private readonly options: SpacesHostOptions) {
		this.router = new InputRouter(options.prefix)
		this.schedule = options.schedule ?? realSchedule
	}

	start(): void {
		const { input, output } = this.options
		output.write(ENTER_SCREEN)
		input.setEncoding?.('utf8')
		input.setRawMode?.(true)
		input.resume?.()
		input.on('data', this.onData)
		output.on('resize', this.onResize)
		const size = this.mainSize()
		const session = new ChildSession(
			this.options.label,
			this.options.spec,
			size,
			() => this.sessionChanged(),
			this.options.kill,
		)
		this.sessions.push(session)
		session.start(this.options.binding)
		this.requestRender()
	}

	private layout() {
		return computeLayout(this.options.output.columns, this.options.output.rows, this.sidebarVisible)
	}

	private mainSize(): { cols: number; rows: number } {
		const { main } = this.layout()
		return { cols: Math.max(1, main.width), rows: Math.max(1, main.height) }
	}

	private relayout(): void {
		if (this.closed) return
		const { cols, rows } = this.mainSize()
		for (const session of this.sessions) session.resize(cols, rows)
		this.writer.invalidate()
		this.requestRender()
	}

	/** Called with what the keyboard sent. */
	handleInput(chunk: string): void {
		if (this.closed) return
		const session = this.sessions[this.selected]
		for (const action of this.router.feed(chunk)) {
			if (action.type === 'write') session?.write(action.data)
			else if (action.type === 'mode') {
				this.confirmingQuit = false
				this.requestRender()
			} else this.navigate(action.key)
		}
	}

	private navigate(key: NavKey): void {
		if (this.confirmingQuit) {
			if (key.kind === 'char' && key.char === 'y') this.quit()
			this.confirmingQuit = false
			this.requestRender()
			return
		}
		if (key.kind === 'up') this.select(this.selected - 1)
		else if (key.kind === 'down') this.select(this.selected + 1)
		else if (key.kind === 'char') {
			if (key.char === 'k') this.select(this.selected - 1)
			else if (key.char === 'j') this.select(this.selected + 1)
			else if (/^[1-9]$/u.test(key.char)) this.select(Number(key.char) - 1)
			else if (key.char === 'b') {
				this.sidebarVisible = !this.sidebarVisible
				this.relayout()
			} else if (key.char === 'q') {
				if (this.sessions.every((s) => s.status === 'exited')) this.quit()
				else this.confirmingQuit = true
			}
		}
		this.requestRender()
	}

	private select(index: number): void {
		if (index < 0 || index >= this.sessions.length) return
		this.selected = index
	}

	private requestRender(): void {
		if (this.closed || this.pending) return
		const cancel = this.schedule(() => {
			this.pending = undefined
			void this.render()
		}, FRAME_MS)
		this.pending = cancel
	}

	/** Paints the current state now, after the emulator has taken all output received so far. */
	render(): Promise<void> {
		this.rendering = this.rendering.then(() => this.paint())
		return this.rendering
	}

	private async paint(): Promise<void> {
		if (this.closed) return
		const session = this.sessions[this.selected]
		if (session) await session.screen.settled()
		if (this.closed) return
		const { output } = this.options
		const frame = new Frame(output.columns, output.rows)
		const layout = this.layout()
		if (layout.sidebar)
			drawSidebar(frame, layout.sidebar, {
				sessions: this.sessions,
				selected: this.selected,
				mode: this.router.current,
				prefixName: this.options.prefix.name,
				confirmingQuit: this.confirmingQuit,
			})
		if (layout.rule) drawRule(frame, layout.rule)
		if (session) {
			frame.blit(session.screen.cells(), layout.main)
			if (session.status === 'exited') {
				const row = layout.main.height - 1
				const banner = { ...layout.main, y: layout.main.y + row, height: 1 }
				frame.fillRect(banner, { attrs: ATTR_INVERSE })
				frame.writeText(layout.main, row, ` ${endedMessage(session, this.options.prefix.name)}`, {
					attrs: ATTR_INVERSE,
				})
				frame.setCursor({ x: 0, y: 0, visible: false })
			}
		}
		// With the sidebar hidden its hints would vanish, so they take one row of the session area.
		if (!layout.sidebar && (this.router.current === 'navigate' || this.confirmingQuit)) {
			const exited = session?.status === 'exited'
			const row = layout.main.height - (exited ? 2 : 1)
			const hint = this.confirmingQuit
				? 'Quit and end session?  y yes   n stay'
				: 'j/k move   enter focus   b sidebar   q quit   esc back'
			frame.fillRect({ ...layout.main, y: layout.main.y + row, height: 1 }, { attrs: ATTR_INVERSE })
			frame.writeText(layout.main, row, ` ${hint}`, { attrs: ATTR_INVERSE })
		}
		if (this.router.current === 'navigate')
			frame.setCursor({ x: frame.cursor.x, y: frame.cursor.y, visible: false })
		let out = ''
		const wantPaste = session?.screen.bracketedPaste() ?? false
		if (wantPaste !== this.pasteOn) {
			this.pasteOn = wantPaste
			out += wantPaste ? '\x1b[?2004h' : '\x1b[?2004l'
		}
		out += this.writer.render(frame)
		if (out !== '') output.write(out)
	}

	/** Ends every session, then leaves the terminal as it was found. */
	quit(): void {
		if (this.quitting || this.closed) return
		this.quitting = true
		const live = this.sessions.filter((s) => s.status !== 'exited')
		if (live.length === 0) {
			this.close()
			return
		}
		for (const session of live) session.stop('SIGHUP')
		this.cancelKill = this.schedule(() => {
			for (const session of live) session.stop('SIGKILL')
			this.close()
		}, QUIT_GRACE_MS)
		// The sessions report their ends through sessionChanged, which closes once all are gone.
	}

	private sessionChanged(): void {
		if (this.quitting && this.sessions.every((s) => s.status === 'exited')) this.close()
		else this.requestRender()
	}

	private close(): void {
		if (this.closed) return
		this.closed = true
		this.cancelKill?.()
		this.pending?.()
		const { input, output } = this.options
		input.off('data', this.onData)
		output.off('resize', this.onResize)
		input.setRawMode?.(false)
		input.pause?.()
		output.write(LEAVE_SCREEN)
		for (const session of this.sessions) session.dispose()
		this.finish(0)
	}
}
