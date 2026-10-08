import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { type ITheme, Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { TerminalTabView } from '../shared/terminal-tabs.js'
import type {
	TerminalAttachOptions,
	TerminalAttachView,
	TerminalEvent,
} from '../shared/terminal-view.js'
import { TerminalFeed } from './terminal-feed.js'
import { terminalKeyAction } from './terminal-keys.js'
import { pasteLineCount, pasteNeedsConfirmation, sanitizePaste } from './terminal-paste.js'

/** The part of the desktop API a terminal view uses. */
export interface TerminalSessionApi {
	attachTerminal(
		tabId: string,
		viewerId: string,
		options?: TerminalAttachOptions,
	): Promise<TerminalAttachView>
	detachTerminal(tabId: string, viewerId: string): Promise<void>
	writeTerminal(tabId: string, viewerId: string, data: string): Promise<void>
	resizeTerminal(tabId: string, viewerId: string, cols: number, rows: number): Promise<void>
	onTerminalEvent(listener: (event: TerminalEvent) => void): () => void
	openExternal?(url: string): Promise<void>
	copyText?(text: string): Promise<void>
}

export interface TerminalSessionState {
	/** `attaching` until the host has answered, `live` while it runs, `ended` once the process is gone. */
	phase: 'attaching' | 'live' | 'ended' | 'failed'
	status: TerminalTabView['status']
	exitCode?: number
	/** This view types into the terminal. */
	writer: boolean
	/** Another view held the keyboard when this one asked. */
	keyboardTaken: boolean
	error?: string
}

export interface TerminalSessionOptions {
	theme: ITheme
	fontFamily: string
	fontSize: number
	mac: boolean
	/** Ctrl/Cmd+F inside the terminal. */
	onFind: () => void
}

const KEYBOARD_TAKEN = /typing in this terminal/i

/**
 * One terminal as this window sees it: the emulator, the stream into it and the keyboard out of it.
 *
 * It lives as long as the tab does, not as long as the tab is in front, so switching tabs costs
 * nothing and the scrollback is whole. Reloading the window loses it, and the next attach rebuilds
 * the screen from the host's snapshot.
 */
export class TerminalSession {
	readonly term: Terminal
	readonly search = new SearchAddon()
	private readonly fit = new FitAddon()
	private readonly feed: TerminalFeed
	private readonly viewerId = `view-${crypto.randomUUID()}`
	private readonly listeners = new Set<() => void>()
	private readonly stop: () => void
	private opened = false
	private disposed = false
	private writes: Promise<void> = Promise.resolve()
	private sentSize = ''
	private sizing = false
	private current: TerminalSessionState = {
		phase: 'attaching',
		status: 'running',
		writer: false,
		keyboardTaken: false,
	}
	private attachToken = 0

	constructor(
		private readonly api: TerminalSessionApi,
		readonly tabId: string,
		private readonly options: TerminalSessionOptions,
	) {
		this.term = new Terminal({
			allowProposedApi: true,
			cursorBlink: true,
			fontFamily: options.fontFamily,
			fontSize: options.fontSize,
			lineHeight: 1.15,
			scrollback: 5000,
			macOptionIsMeta: true,
			theme: options.theme,
			// The terminal's own contrast fix keeps program colours readable on either background.
			minimumContrastRatio: 4.5,
			// Links a program draws (OSC 8) go through the same check in the main process as detected
			// ones: web addresses only, never the emulator's own confirm-and-open.
			linkHandler: {
				allowNonHttpProtocols: false,
				activate: (_event, uri) => void this.api.openExternal?.(uri).catch(() => undefined),
				hover: (_event, uri) => {
					if (this.term.element) this.term.element.title = uri
				},
				leave: () => {
					if (this.term.element) this.term.element.title = ''
				},
			},
		})
		this.term.loadAddon(this.fit)
		this.term.loadAddon(this.search)
		this.term.loadAddon(new Unicode11Addon())
		this.term.unicode.activeVersion = '11'
		this.term.loadAddon(
			new WebLinksAddon((_event, uri) => {
				void this.api.openExternal?.(uri).catch(() => undefined)
			}),
		)
		this.feed = new TerminalFeed(
			(data) => this.term.write(data),
			() => void this.attach({ fromOffset: this.feed.next }),
		)
		this.term.onData((data) => this.send(data))
		this.term.onResize(() => this.syncSize())
		this.term.attachCustomKeyEventHandler((event) => this.key(event))
		this.stop = this.api.onTerminalEvent((event) => this.onEvent(event))
		void this.attach({})
	}

	get state(): TerminalSessionState {
		return this.current
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	private update(patch: Partial<TerminalSessionState>): void {
		this.current = { ...this.current, ...patch }
		// An ended session has nothing to type into; its cursor would only be a solid block.
		if (patch.phase === 'ended' && !this.disposed) this.term.write('\u001b[?25l')
		for (const listener of [...this.listeners]) listener()
	}

	/** Show the terminal inside `host`. The emulator is made once and moved between hosts. */
	mount(host: HTMLElement): void {
		if (this.disposed) return
		if (!this.opened) {
			this.opened = true
			this.term.open(host)
			this.guardPaste()
			try {
				const webgl = new WebglAddon()
				// A lost context falls back to the DOM renderer rather than drawing nothing.
				webgl.onContextLoss(() => webgl.dispose())
				this.term.loadAddon(webgl)
			} catch {
				/* No WebGL here: the DOM renderer draws it. */
			}
		} else if (this.term.element && this.term.element.parentElement !== host) {
			host.appendChild(this.term.element)
		}
		this.refit()
	}

	/** Pasted text is cleaned of control characters before the emulator sends it. */
	private guardPaste(): void {
		const area = this.term.textarea
		if (!area) return
		area.addEventListener(
			'paste',
			(event: ClipboardEvent) => {
				event.preventDefault()
				event.stopImmediatePropagation()
				const text = sanitizePaste(event.clipboardData?.getData('text/plain') ?? '')
				if (text.length === 0) return
				if (
					pasteNeedsConfirmation(text, this.term.modes.bracketedPasteMode) &&
					!window.confirm(
						`Paste ${pasteLineCount(text)} lines? This program does not hold pasted text back, so each line runs as soon as it arrives.`,
					)
				)
					return
				this.term.paste(text)
			},
			{ capture: true },
		)
	}

	/** Fit to the host. A hidden or empty host is left alone. */
	refit(): void {
		if (this.disposed || !this.opened) return
		const parent = this.term.element?.parentElement
		if (!parent || parent.clientWidth === 0 || parent.clientHeight === 0) return
		try {
			this.fit.fit()
		} catch {
			/* Measured while detached. */
		}
	}

	focus(): void {
		if (!this.disposed && this.opened) this.term.focus()
	}

	setTheme(theme: ITheme): void {
		if (!this.disposed) this.term.options.theme = theme
	}

	setFont(fontFamily: string, fontSize: number): void {
		if (this.disposed) return
		this.term.options.fontFamily = fontFamily
		this.term.options.fontSize = fontSize
		this.refit()
	}

	/** The text on the screen and in the scrollback, for tests and diagnostics. */
	text(): string {
		const buffer = this.term.buffer.active
		const lines: string[] = []
		for (let row = 0; row < buffer.length; row++)
			lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
		return lines.join('\n').replace(/\n+$/u, '')
	}

	async copySelection(): Promise<void> {
		const text = this.term.getSelection()
		if (text) await this.api.copyText?.(text).catch(() => undefined)
	}

	/** Ask for the keyboard back from another view. */
	takeKeyboard(): void {
		void this.attach({ fromOffset: this.feed.next, force: true })
	}

	private key(event: KeyboardEvent): boolean {
		if (event.type !== 'keydown') return true
		const action = terminalKeyAction(event, {
			hasSelection: this.term.hasSelection(),
			mac: this.options.mac,
		})
		switch (action) {
			case 'copy':
				event.preventDefault()
				void this.copySelection()
				return false
			case 'paste':
				// The browser pastes into the input and the emulator sends it, bracketed when the program asks.
				return false
			case 'find':
				event.preventDefault()
				this.options.onFind()
				return false
			case 'app':
				return false
			default:
				return true
		}
	}

	private send(data: string): void {
		if (!this.current.writer || this.current.phase !== 'live') return
		this.writes = this.writes
			.then(() => this.api.writeTerminal(this.tabId, this.viewerId, data))
			.catch((error: unknown) => {
				this.update({ error: error instanceof Error ? error.message : String(error) })
			})
	}

	private syncSize(): void {
		if (this.sizing) return
		this.sizing = true
		queueMicrotask(() => {
			this.sizing = false
			if (this.disposed || !this.current.writer || this.current.phase !== 'live') return
			const { cols, rows } = this.term
			const key = `${cols}x${rows}`
			if (key === this.sentSize) return
			this.sentSize = key
			void this.api.resizeTerminal(this.tabId, this.viewerId, cols, rows).catch(() => {
				this.sentSize = ''
			})
		})
	}

	private onEvent(event: TerminalEvent): void {
		if (event.tabId !== this.tabId || this.disposed) return
		if (event.kind === 'data') this.feed.accept(event.offset, event.data)
		else
			this.update({
				phase: 'ended',
				status: 'exited',
				writer: false,
				...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
			})
	}

	private async attach(options: TerminalAttachOptions): Promise<void> {
		if (this.disposed) return
		const token = ++this.attachToken
		this.feed.begin()
		let result: TerminalAttachView
		let keyboardTaken = false
		try {
			try {
				result = await this.api.attachTerminal(this.tabId, this.viewerId, {
					...options,
					writer: true,
				})
			} catch (error) {
				if (!(error instanceof Error) || !KEYBOARD_TAKEN.test(error.message)) throw error
				// Another view is typing: this one watches, and offers to take over.
				keyboardTaken = true
				result = await this.api.attachTerminal(this.tabId, this.viewerId, {
					...(options.fromOffset === undefined ? {} : { fromOffset: options.fromOffset }),
				})
			}
		} catch (error) {
			if (token !== this.attachToken || this.disposed) return
			this.update({
				phase: 'failed',
				error: error instanceof Error ? error.message : String(error),
			})
			return
		}
		if (token !== this.attachToken || this.disposed) return
		if (result.mode === 'snapshot') {
			this.term.reset()
			this.term.write(result.screen + result.data)
			this.feed.reset(result.end)
		} else {
			this.term.write(result.data)
			this.feed.resume(result.end)
		}
		const ended = result.status !== 'running'
		this.update({
			phase: ended ? 'ended' : 'live',
			status: result.status,
			writer: result.writer,
			keyboardTaken,
			error: undefined,
			...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
		})
		if (result.writer) {
			this.sentSize = ''
			this.syncSize()
		}
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.stop()
		this.listeners.clear()
		void this.api.detachTerminal(this.tabId, this.viewerId).catch(() => undefined)
		this.term.dispose()
	}
}

/** The sessions of this window, by tab. */
export class TerminalSessions {
	private readonly sessions = new Map<string, TerminalSession>()

	constructor(
		private readonly create: (tabId: string) => TerminalSession,
		private readonly onChange?: () => void,
	) {}

	get(tabId: string): TerminalSession {
		let session = this.sessions.get(tabId)
		if (!session) {
			session = this.create(tabId)
			this.sessions.set(tabId, session)
			this.onChange?.()
		}
		return session
	}

	peek(tabId: string): TerminalSession | undefined {
		return this.sessions.get(tabId)
	}

	/** Keep the sessions of these tabs and end the rest: a tab that left the window takes its view with it. */
	retain(tabIds: ReadonlySet<string>): void {
		for (const [id, session] of this.sessions) {
			if (tabIds.has(id)) continue
			session.dispose()
			this.sessions.delete(id)
		}
		this.onChange?.()
	}

	each(visit: (session: TerminalSession) => void): void {
		for (const session of this.sessions.values()) visit(session)
	}
}
