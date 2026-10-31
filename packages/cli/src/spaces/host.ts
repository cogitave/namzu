import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { ATTR_INVERSE } from '../terminal/host/cell.js'
import { Frame } from '../terminal/host/frame.js'
import { DiffWriter } from '../terminal/host/writer.js'
import type { HostPtyModule } from '../terminal/pty.js'
import { InputRouter, type MouseEvent, type NavKey } from './input.js'
import { computeLayout } from './layout.js'
import { type PeerSource, recordForSlot } from './peers.js'
import type { Prefix } from './prefix.js'
import { type Entry, Roster, type Space } from './roster.js'
import { ChildSession, type SessionSpec } from './session.js'
import {
	type SidebarScroll,
	arrange,
	clampScroll,
	drawRule,
	drawSidebar,
	endedMessage,
	hitTest,
	regionAt,
} from './sidebar.js'

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

/** What the host asks of the program that starts a session. */
export interface SessionRequest {
	readonly cwd: string
	/** Identifies the session to the feed; the program reports it back in its live record. */
	readonly slot: string
	/** True for the session the command itself started, which alone receives the command's own options. */
	readonly first: boolean
}

export interface SpacesHostOptions {
	readonly input: HostInput
	readonly output: HostOutput
	readonly binding: HostPtyModule
	/** The program for a session. */
	readonly spec: (request: SessionRequest) => SessionSpec
	/** The space the host opens with, and starts a session in. */
	readonly folder: { readonly cwd: string; readonly name: string }
	/** Spaces and sessions shown but not started until opened. */
	readonly listed?: readonly { cwd: string; name: string; sessions: number }[]
	readonly prefix: Prefix
	readonly schedule?: Schedule
	/** How a session's whole process tree is ended; the default signals its process group. */
	readonly kill?: ConstructorParameters<typeof ChildSession>[4]
	/** Where the sessions' states come from; without it every started session shows as starting. */
	readonly peers?: PeerSource
	readonly newSlot?: () => string
	readonly isDirectory?: (path: string) => boolean
	readonly homeDirectory?: string
}

/** At most about 60 frames a second. */
const FRAME_MS = 16
/** How often the records are read when the file watcher says nothing. */
const POLL_MS = 1000
/** How often each terminal is asked directly, to catch a change that was never written. */
const RECONCILE_MS = 2500
/** How long a session gets to save itself after a hang-up before it is ended outright. */
const QUIT_GRACE_MS = 3000
/** Rows one wheel notch moves. */
const WHEEL_ROWS = 3

const ENTER_SCREEN = '\x1b[?1049h\x1b[2J\x1b[?1000h\x1b[?1006h'
const LEAVE_SCREEN = '\x1b[?1006l\x1b[?1000l\x1b[?2004l\x1b[?25h\x1b[?1049l'

type Prompt = { kind: 'folder' | 'rename-session' | 'rename-space'; value: string; error?: string }
type Confirm = 'quit' | 'close-session' | 'close-space'

function defaultIsDirectory(path: string): boolean {
	try {
		return existsSync(path) && statSync(path).isDirectory()
	} catch {
		return false
	}
}

/**
 * The spaces shell: a sidebar of spaces and sessions, and the selected session's
 * screen beside it.
 *
 * It draws and routes keys and nothing else. Each session is a whole `namzu`
 * running in its own pseudo-terminal, so a session that crashes greys its row and
 * the rest keep running. What a session is doing comes from the live record its
 * terminal publishes, never from reading its screen.
 */
export class SpacesHost {
	readonly roster = new Roster()
	private sidebarVisible = true
	private sidebarScroll: SidebarScroll = { spaces: 0, sessions: 0 }
	private confirm: Confirm | undefined
	private prompt: Prompt | undefined
	private notice: string | undefined
	private pasteOn = false
	private pending: (() => void) | undefined
	private rendering: Promise<void> = Promise.resolve()
	private closed = false
	private quitting = false
	private firstSession = true
	private cancelKill: (() => void) | undefined
	private cancelPoll: (() => void) | undefined
	private cancelReconcile: (() => void) | undefined
	private stopWatching: (() => void) | undefined
	private reconciling = false
	private readonly leaving: ChildSession[] = []
	/** The session last shown in each space, so coming back lands where you were. */
	private readonly lastShown = new Map<string, Entry>()
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
		const space = this.roster.addSpace(this.options.folder.cwd, this.options.folder.name)
		const entry = this.addEntry(space)
		for (const listed of this.options.listed ?? []) {
			const other = this.roster.addSpace(listed.cwd, listed.name)
			for (let i = 0; i < listed.sessions; i++) this.addEntry(other)
		}
		this.open(entry)
		this.armPoll()
		this.armReconcile()
		this.stopWatching = this.options.peers?.watch?.(() => this.readStatus())
		this.requestRender()
	}

	// --- sessions --------------------------------------------------------------

	private addEntry(space: Space): Entry {
		return this.roster.addSession(space, this.options.newSlot?.() ?? randomUUID())
	}

	private layout() {
		return computeLayout(this.options.output.columns, this.options.output.rows, this.sidebarVisible)
	}

	private mainSize(): { cols: number; rows: number } {
		const { main } = this.layout()
		return { cols: Math.max(1, main.width), rows: Math.max(1, main.height) }
	}

	/** Starts the entry's terminal if it has none yet. */
	private ensureStarted(entry: Entry): void {
		if (entry.child || this.closed) return
		const space = this.roster.spaceOf(entry)
		const spec = this.options.spec({
			cwd: space.cwd,
			slot: entry.slot,
			first: this.firstSession,
		})
		this.firstSession = false
		const child = new ChildSession(
			entry.label,
			spec,
			this.mainSize(),
			() => this.childChanged(entry),
			this.options.kill,
		)
		entry.child = child
		child.start(this.options.binding)
		this.roster.update(entry)
	}

	/** Shows a session and starts it when it has not been opened before. */
	private open(entry: Entry): void {
		this.show(entry)
		this.ensureStarted(entry)
		this.router.focus()
		this.requestRender()
	}

	/** Shows a session without starting it. */
	private show(entry: Entry): void {
		this.roster.select(entry)
		this.lastShown.set(entry.spaceId, entry)
		this.revealSelected()
	}

	private childChanged(entry: Entry): void {
		this.roster.update(entry)
		for (let i = this.leaving.length - 1; i >= 0; i--) {
			const gone = this.leaving[i]
			if (gone?.status === 'exited') {
				gone.dispose()
				this.leaving.splice(i, 1)
			}
		}
		if (this.quitting && this.everyChild().every((c) => c.status === 'exited')) this.close()
		else this.requestRender()
	}

	private everyChild(): ChildSession[] {
		const own = this.roster.entries.flatMap((e) => (e.child ? [e.child] : []))
		return [...own, ...this.leaving]
	}

	private relayout(): void {
		if (this.closed) return
		const { cols, rows } = this.mainSize()
		for (const entry of this.roster.entries) entry.child?.resize(cols, rows)
		this.writer.invalidate()
		this.requestRender()
	}

	// --- status feed -----------------------------------------------------------

	private armPoll(): void {
		if (!this.options.peers || this.closed) return
		this.cancelPoll = this.schedule(() => {
			this.readStatus()
			this.armPoll()
		}, POLL_MS)
	}

	private armReconcile(): void {
		if (!this.options.peers || this.closed) return
		this.cancelReconcile = this.schedule(() => {
			void this.reconcile().finally(() => this.armReconcile())
		}, RECONCILE_MS)
	}

	/** Takes what each session's terminal last wrote about itself. */
	readStatus(): void {
		const peers = this.options.peers
		if (!peers || this.closed) return
		let records: ReturnType<PeerSource['records']>
		try {
			records = peers.records()
		} catch {
			return
		}
		let changed = false
		for (const entry of this.roster.entries) {
			if (!entry.child || entry.child.status === 'exited') continue
			const record = recordForSlot(records, entry.slot, entry.child.pid)
			if (!record) continue
			if (entry.reported !== record.state) changed = true
			entry.reported = record.state
			if (entry.account !== record.account) changed = true
			entry.account = record.account
			entry.limited = record.limited === true
			entry.conversationId = record.conversationId
			this.roster.update(entry)
		}
		if (changed) this.requestRender()
	}

	/** Asks each terminal its state directly, so a change that was never written is still seen. */
	async reconcile(): Promise<void> {
		const peers = this.options.peers
		if (!peers || this.closed || this.reconciling) return
		this.reconciling = true
		try {
			let records: ReturnType<PeerSource['records']>
			try {
				records = peers.records()
			} catch {
				return
			}
			const asks = this.roster.entries.flatMap((entry) => {
				if (!entry.child || entry.child.status === 'exited') return []
				const record = recordForSlot(records, entry.slot, entry.child.pid)
				return record ? [{ entry, record }] : []
			})
			await Promise.all(
				asks.map(async ({ entry, record }) => {
					const state = await peers.ping(record)
					if (state === undefined || this.closed) return
					if (!this.roster.entries.includes(entry) || entry.reported === state) return
					entry.reported = state
					this.roster.update(entry)
					this.requestRender()
				}),
			)
		} finally {
			this.reconciling = false
		}
	}

	// --- input -----------------------------------------------------------------

	/** Called with what the keyboard sent. */
	handleInput(chunk: string): void {
		if (this.closed) return
		for (const action of this.router.feed(chunk)) {
			if (action.type === 'write') this.writeToSelected(action.data)
			else if (action.type === 'mode') {
				this.confirm = undefined
				if (action.mode === 'terminal') {
					const entry = this.roster.selected
					if (entry) this.open(entry)
				}
				this.requestRender()
			} else if (action.type === 'mouse') this.mouse(action.mouse)
			else this.navigate(action.key)
		}
	}

	private writeToSelected(data: string): void {
		const entry = this.roster.selected
		if (!entry) return
		this.ensureStarted(entry)
		entry.scrollBack = 0
		entry.child?.write(data)
	}

	private navigate(key: NavKey): void {
		this.notice = undefined
		if (this.prompt) {
			this.promptKey(key)
			this.requestRender()
			return
		}
		if (this.confirm) {
			const confirmed = this.confirm
			this.confirm = undefined
			if (key.kind === 'char' && key.char === 'y') this.perform(confirmed)
			this.requestRender()
			return
		}
		const entry = this.roster.selected
		if (key.kind === 'up') this.step(-1)
		else if (key.kind === 'down') this.step(1)
		else if (key.kind === 'char' && entry) {
			const c = key.char
			if (c === 'k') this.step(-1)
			else if (c === 'j') this.step(1)
			else if (c === 'K') this.stepSpace(-1)
			else if (c === 'J') this.stepSpace(1)
			else if (/^[1-9]$/u.test(c)) this.gotoSpace(Number(c) - 1)
			else if (c === 'n') this.newSession()
			else if (c === 'N') this.askFolder()
			else if (c === 'r') this.prompt = { kind: 'rename-session', value: entry.label }
			else if (c === 'R')
				this.prompt = { kind: 'rename-space', value: this.roster.spaceOf(entry).name }
			else if (c === 'd') this.confirm = 'close-session'
			else if (c === 'D') this.confirm = 'close-space'
			else if (c === 'b') {
				this.sidebarVisible = !this.sidebarVisible
				this.relayout()
			} else if (c === 'q') {
				if (this.everyChild().every((s) => s.status === 'exited')) this.quit()
				else this.confirm = 'quit'
			}
			this.router.capture(this.prompt !== undefined)
		}
		this.requestRender()
	}

	/** Moves the highlight among the sessions of the current space. */
	private step(delta: number): void {
		const entry = this.roster.selected
		if (!entry) return
		const own = this.roster.entriesOf(this.roster.spaceOf(entry))
		const next = own[own.indexOf(entry) + delta]
		if (next) this.show(next)
	}

	private stepSpace(delta: number): void {
		const entry = this.roster.selected
		if (!entry) return
		this.gotoSpace(this.roster.spaces.indexOf(this.roster.spaceOf(entry)) + delta)
	}

	private gotoSpace(index: number): void {
		const space = this.roster.spaces[index]
		if (!space) return
		const remembered = this.lastShown.get(space.id)
		const entry =
			remembered && this.roster.entries.includes(remembered)
				? remembered
				: this.roster.entriesOf(space)[0]
		if (entry) this.show(entry)
	}

	private newSession(): void {
		const entry = this.roster.selected
		if (!entry) return
		this.open(this.addEntry(this.roster.spaceOf(entry)))
	}

	private askFolder(): void {
		this.prompt = { kind: 'folder', value: '' }
		this.router.capture(true)
	}

	private promptKey(key: NavKey): void {
		const prompt = this.prompt
		if (!prompt) return
		if (key.kind === 'escape') {
			this.endPrompt()
			return
		}
		if (key.kind === 'backspace') {
			prompt.value = prompt.value.slice(0, -1)
			delete prompt.error
			return
		}
		if (key.kind === 'char') {
			prompt.value += key.char
			delete prompt.error
			return
		}
		if (key.kind !== 'enter') return
		const value = prompt.value.trim()
		if (prompt.kind === 'folder') {
			if (value === '') {
				this.endPrompt()
				return
			}
			const path = this.expand(value)
			if (!(this.options.isDirectory ?? defaultIsDirectory)(path)) {
				prompt.error = 'No such folder.'
				return
			}
			this.endPrompt()
			this.openFolder(path)
			return
		}
		const entry = this.roster.selected
		if (value !== '' && entry) {
			if (prompt.kind === 'rename-session') entry.label = value
			else this.roster.spaceOf(entry).name = value
		}
		this.endPrompt()
	}

	private endPrompt(): void {
		this.prompt = undefined
		this.router.capture(false)
	}

	private expand(value: string): string {
		const home = this.options.homeDirectory ?? homedir()
		const full = value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value
		const base = this.roster.selected
			? this.roster.spaceOf(this.roster.selected).cwd
			: this.options.folder.cwd
		return isAbsolute(full) ? resolve(full) : resolve(base, full)
	}

	/** Opens a folder as a space, or shows the space it already is. */
	private openFolder(path: string): void {
		const known = this.roster.spaces.find((s) => s.cwd === path)
		if (known) {
			const entry = this.lastShown.get(known.id) ?? this.roster.entriesOf(known)[0]
			if (entry) this.open(entry)
			return
		}
		const space = this.roster.addSpace(path, basename(path) || path)
		this.open(this.addEntry(space))
	}

	private perform(what: Confirm): void {
		const entry = this.roster.selected
		if (what === 'quit') {
			this.quit()
			return
		}
		if (!entry) return
		const doomed =
			what === 'close-session' ? [entry] : this.roster.entriesOf(this.roster.spaceOf(entry))
		if (doomed.length === this.roster.entries.length) {
			this.quit()
			return
		}
		for (const item of doomed) {
			if (item.child && item.child.status !== 'exited') {
				this.leaving.push(item.child)
				item.child.stop('SIGHUP')
			} else item.child?.dispose()
			this.lastShown.delete(item.spaceId)
			this.roster.removeEntry(item)
		}
		const next = this.roster.selected
		if (next) this.show(next)
	}

	// --- mouse -----------------------------------------------------------------

	private mouse(event: MouseEvent): void {
		if (this.prompt || this.confirm) return
		const layout = this.layout()
		const inSidebar = layout.sidebar !== undefined && event.x < layout.sidebar.width
		if (event.kind === 'wheel-up' || event.kind === 'wheel-down') {
			const direction = event.kind === 'wheel-up' ? -1 : 1
			if (inSidebar && layout.sidebar) {
				const arrangement = arrange(this.roster, layout.sidebar.height, this.footLines().length)
				const region = regionAt(arrangement, event.y)
				if (region)
					this.sidebarScroll = clampScroll(
						{
							...this.sidebarScroll,
							[region]: this.sidebarScroll[region] + direction * WHEEL_ROWS,
						},
						arrangement,
					)
			} else {
				const entry = this.roster.selected
				const size = entry?.child?.screen.scrollbackSize() ?? 0
				if (entry)
					entry.scrollBack = Math.max(0, Math.min(size, entry.scrollBack - direction * WHEEL_ROWS))
			}
			this.requestRender()
			return
		}
		if (event.kind !== 'press') return
		if (!inSidebar || !layout.sidebar) {
			if (this.router.current === 'navigate') this.router.focus()
			this.requestRender()
			return
		}
		const target = hitTest(
			arrange(this.roster, layout.sidebar.height, this.footLines().length),
			this.sidebarScroll,
			event.y,
		)
		if (target?.kind === 'session') this.open(target.entry)
		else if (target?.kind === 'space') {
			const index = this.roster.spaces.indexOf(target.space)
			this.gotoSpace(index)
			const shown = this.roster.selected
			if (shown) this.open(shown)
		}
		this.requestRender()
	}

	private revealSelected(): void {
		const height = this.layout().sidebar?.height
		if (height === undefined) return
		this.sidebarScroll = clampScroll(
			this.sidebarScroll,
			arrange(this.roster, height, this.footLines().length),
			true,
		)
	}

	// --- drawing ---------------------------------------------------------------

	private footLines(): string[] {
		const entry = this.roster.selected
		const prefix = this.options.prefix.name
		if (this.prompt) {
			const label =
				this.prompt.kind === 'folder'
					? 'Folder'
					: this.prompt.kind === 'rename-session'
						? 'Session name'
						: 'Space name'
			return [`${label}: ${this.prompt.value}▏`, this.prompt.error ?? 'enter ok   esc cancel']
		}
		if (this.confirm === 'quit') return ['Quit all sessions?', 'y yes   n stay']
		if (this.confirm && entry) {
			const space = this.roster.spaceOf(entry)
			const what =
				this.confirm === 'close-session'
					? `Close "${entry.label}"?`
					: `Close space "${space.name}" and its ${this.roster.entriesOf(space).length} sessions?`
			return [what, 'y yes   n stay']
		}
		if (this.router.current === 'navigate') {
			const full = [
				'j/k session   J/K space',
				'n new   N new space',
				'r rename   R rename space',
				'd close   D close space',
				'enter focus   b sidebar',
				'q quit   esc back',
			]
			return this.options.output.rows >= 28 ? full : full.slice(0, 2).concat(full.slice(4, 5))
		}
		return this.notice ? [this.notice, `${prefix} to navigate`] : [`${prefix} to navigate`]
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
		const entry = this.roster.selected
		const child = entry?.child
		if (child) await child.screen.settled()
		if (this.closed) return
		const { output } = this.options
		const frame = new Frame(output.columns, output.rows)
		const layout = this.layout()
		const foot = this.footLines()
		if (layout.sidebar) {
			this.sidebarScroll = clampScroll(
				this.sidebarScroll,
				arrange(this.roster, layout.sidebar.height, foot.length),
			)
			drawSidebar(frame, layout.sidebar, {
				roster: this.roster,
				mode: this.router.current,
				foot,
				scroll: this.sidebarScroll,
			})
		}
		if (layout.rule) drawRule(frame, layout.rule)
		const bottom = (offset: number) => ({
			...layout.main,
			y: layout.main.y + layout.main.height - 1 - offset,
			height: 1,
		})
		if (entry && child) {
			frame.blit(child.screen.cells(entry.scrollBack), layout.main)
			if (child.status === 'exited') {
				const row = layout.main.height - 1
				frame.fillRect(bottom(0), { attrs: ATTR_INVERSE })
				frame.writeText(
					layout.main,
					row,
					` ${endedMessage(child.ending, this.options.prefix.name)}`,
					{ attrs: ATTR_INVERSE },
				)
				frame.setCursor({ x: 0, y: 0, visible: false })
			} else if (entry.scrollBack > 0) {
				frame.fillRect(bottom(0), { attrs: ATTR_INVERSE })
				frame.writeText(
					layout.main,
					layout.main.height - 1,
					' Scrolled back. Scroll down or type to return.',
					{ attrs: ATTR_INVERSE },
				)
			}
		} else if (entry) {
			const space = this.roster.spaceOf(entry)
			frame.writeText(layout.main, 1, `  "${entry.label}" in ${space.name} has not started yet.`)
			frame.writeText(layout.main, 2, '  Press enter or click it in the list to open it.')
		}
		// With the sidebar hidden its foot would vanish, so it takes one row of the session area.
		if (!layout.sidebar && (this.router.current === 'navigate' || this.prompt || this.confirm)) {
			const exited = child?.status === 'exited'
			const area = bottom(exited || (entry?.scrollBack ?? 0) > 0 ? 1 : 0)
			frame.fillRect(area, { attrs: ATTR_INVERSE })
			frame.writeText(area, 0, ` ${foot.join('   ')}`, { attrs: ATTR_INVERSE })
		}
		if (this.router.current === 'navigate')
			frame.setCursor({ x: frame.cursor.x, y: frame.cursor.y, visible: false })
		let out = ''
		const wantPaste = child?.screen.bracketedPaste() ?? false
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
		const live = this.everyChild().filter((s) => s.status !== 'exited')
		if (live.length === 0) {
			this.close()
			return
		}
		for (const session of live) session.stop('SIGHUP')
		this.cancelKill = this.schedule(() => {
			for (const session of live) session.stop('SIGKILL')
			this.close()
		}, QUIT_GRACE_MS)
		// The sessions report their ends through childChanged, which closes once all are gone.
	}

	private close(): void {
		if (this.closed) return
		this.closed = true
		this.cancelKill?.()
		this.cancelPoll?.()
		this.cancelReconcile?.()
		this.stopWatching?.()
		this.pending?.()
		const { input, output } = this.options
		input.off('data', this.onData)
		output.off('resize', this.onResize)
		input.setRawMode?.(false)
		input.pause?.()
		output.write(LEAVE_SCREEN)
		for (const child of this.everyChild()) child.dispose()
		this.finish(0)
	}
}
