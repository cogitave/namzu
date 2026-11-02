/**
 * The conversation this process is running, as a pane of the spaces host.
 *
 * Ink is mounted on the pass-through streams of `proxy.ts`. While the spaces
 * screen is up this session's output goes to a headless mirror the size of its
 * pane, which the host draws like any other pane's screen, and the host's keys
 * reach Ink through the same proxy. Taking the session full screen is native:
 * the host leaves the alternate screen, the proxy reports the real size again,
 * and the App reprints its whole transcript from its own message list.
 */

import type { LocalPaneSession, SessionEnding, SessionStatus } from '../../spaces/session.js'
import { HeadlessScreen } from '../../terminal/screen.js'
import type { TerminalProxy } from './proxy.js'

const SCROLLBACK = 2000

export interface LocalSessionDeps {
	readonly proxy: TerminalProxy
	/** The real terminal: where the host draws, and where the session's modes are restored. */
	readonly realOut: { write(data: string): unknown }
	/** Receives every key the terminal sends while the session is in its pane. */
	readonly onKey: (chunk: string) => string | null
	/** Ends the conversation the way `/exit` does. */
	readonly requestExit: () => void
	/** Has the App clear the screen and print its whole transcript again. */
	readonly repaint: () => void
}

export class LocalSession implements LocalPaneSession {
	readonly local = true as const
	status: SessionStatus = 'running'
	ending: SessionEnding | undefined
	readonly pid = process.pid
	private mirror: HeadlessScreen
	private attached = false
	private cols: number
	private rows: number
	private listener: (() => void) | undefined

	constructor(
		private readonly deps: LocalSessionDeps,
		size: { cols: number; rows: number },
	) {
		this.cols = size.cols
		this.rows = size.rows
		this.mirror = new HeadlessScreen(size.cols, size.rows, SCROLLBACK)
	}

	get screen(): HeadlessScreen {
		return this.mirror
	}

	observe(listener: () => void): void {
		this.listener = listener
	}

	private notify(): void {
		this.listener?.()
	}

	attach(cols: number, rows: number): void {
		if (this.status === 'exited') return
		this.cols = Math.max(1, cols)
		this.rows = Math.max(1, rows)
		// A fresh mirror each time: the App prints its whole transcript into it again.
		this.mirror.dispose()
		this.mirror = new HeadlessScreen(this.cols, this.rows, SCROLLBACK)
		this.mirror.onResponse((reply) => this.write(reply))
		this.attached = true
		this.deps.proxy.enterZoomed(
			{
				columns: this.cols,
				rows: this.rows,
				write: (chunk) => {
					// The terminal's line discipline turns LF into CR LF for a real screen; the mirror has none.
					this.mirror.write(chunk.replace(/\r?\n/g, '\r\n'))
					this.notify()
				},
			},
			this.deps.onKey,
		)
		this.deps.repaint()
	}

	detach(): void {
		if (!this.attached) return
		this.attached = false
		const { proxy, realOut } = this.deps
		// The modes Ink asked for before the alternate screen, which the host changed, come back as they were.
		realOut.write(
			(proxy.bracketedPaste ? '\u001b[?2004h' : '\u001b[?2004l') +
				(proxy.cursorHidden ? '\u001b[?25l' : '\u001b[?25h'),
		)
		proxy.leaveZoomed()
		this.deps.repaint()
	}

	write(data: string): void {
		if (this.status === 'exited') return
		this.deps.proxy.inject(data)
	}

	resize(cols: number, rows: number): void {
		if (cols < 1 || rows < 1) return
		if (cols === this.cols && rows === this.rows) return
		this.cols = cols
		this.rows = rows
		if (!this.attached) return
		// The mirror first, so what Ink writes in answer lands in a screen of the new size.
		try {
			this.mirror.resize(cols, rows)
		} catch {
			/* Nothing to redraw. */
		}
		this.deps.proxy.resizeZoomed(cols, rows)
	}

	/** The host quits: the conversation ends as if `/exit` had been typed. */
	stop(): void {
		if (this.status === 'exited') return
		this.deps.requestExit()
	}

	/** The conversation is over (Ink has unmounted); the terminal is the host's to restore. */
	markExited(): void {
		if (this.status === 'exited') return
		this.status = 'exited'
		this.ending = 'finished'
		if (this.attached) {
			this.attached = false
			this.deps.proxy.leaveZoomed()
		}
		this.notify()
	}

	dispose(): void {
		this.mirror.dispose()
	}
}
