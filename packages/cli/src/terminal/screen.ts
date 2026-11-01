import serializePackage from '@xterm/addon-serialize'
import type { SerializeAddon as SerializeAddonType } from '@xterm/addon-serialize'
import headlessPackage from '@xterm/headless'
import type { Terminal as TerminalType } from '@xterm/headless'
import type { CellSource } from './host/frame.js'
import { trackCursorVisibility, xtermSource } from './host/xterm-source.js'

// Both packages are CommonJS bundles: Node's ES loader exposes only their default
// export, whatever a bundler or a test runner would let a named import do.
const { Terminal } = headlessPackage as unknown as { Terminal: typeof TerminalType }
const { SerializeAddon } = serializePackage as unknown as {
	SerializeAddon: typeof SerializeAddonType
}

/**
 * What a terminal looks like right now, kept by a headless emulator fed with the
 * same bytes the viewers get.
 *
 * Two readers need it: a viewer that attaches late or reloads (it restores the
 * serialized screen instead of replaying a megabyte of escape codes), and, later,
 * an agent that wants rendered text rather than a stream of control sequences.
 *
 * The emulator parses asynchronously. `offset()` is therefore the count of
 * characters the emulator has actually consumed, not the count handed to it, so a
 * snapshot always says exactly which output it already contains.
 */
export class HeadlessScreen {
	private readonly term: TerminalType
	private readonly serializer: SerializeAddonType
	private readonly cursorVisible: () => boolean
	private parsed = 0
	private fed = 0
	private clipboardListener: ((data: string) => void) | undefined

	constructor(cols: number, rows: number, scrollback: number) {
		this.serializer = new SerializeAddon()
		this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
		this.term.loadAddon(this.serializer)
		this.cursorVisible = trackCursorVisibility(this.term)
		// OSC 52: the program asks for its text to reach the user's clipboard. The emulator keeps no
		// clipboard of its own, so the request is handed to whoever listens, and consumed either way.
		this.term.parser.registerOscHandler(52, (data) => {
			try {
				this.clipboardListener?.(data)
			} catch {
				/* A listener's failure is not the program's. */
			}
			return true
		})
	}

	/** Calls `listener` with the payload (`selection;base64`) of each clipboard request the program prints. */
	onClipboard(listener: (data: string) => void): void {
		this.clipboardListener = listener
	}

	get cols(): number {
		return this.term.cols
	}

	/** Lines the buffer holds, history included. */
	bufferLength(): number {
		return this.term.buffer.active.length
	}

	/** The buffer line shown at the top row when scrolled `back` rows into the history. */
	viewTop(back = 0): number {
		const buffer = this.term.buffer.active
		return buffer.viewportY - Math.max(0, Math.min(back, buffer.baseY))
	}

	/** Columns `from` up to `to` of a buffer line as text; blanks at the right are cut when `trim`. */
	lineText(line: number, from: number, to: number, trim = true): string {
		return this.term.buffer.active.getLine(line)?.translateToString(trim, from, to) ?? ''
	}

	/** Whether the line continues the one above it (the program's text wrapped, no new line was printed). */
	lineWrapped(line: number): boolean {
		return this.term.buffer.active.getLine(line)?.isWrapped ?? false
	}

	write(data: string): void {
		this.fed += data.length
		const upTo = this.fed
		this.term.write(data, () => {
			this.parsed = upTo
		})
	}

	/** Resolves once everything written so far has been parsed. */
	settled(): Promise<void> {
		return new Promise((resolve) => this.term.write('', () => resolve()))
	}

	resize(cols: number, rows: number): void {
		this.term.resize(cols, rows)
	}

	/** Output offset the serialized screen is exact for. */
	offset(): number {
		return this.parsed
	}

	/** The screen as escape sequences that rebuild it, within `maxLength`. */
	serialize(scrollback: number, maxLength: number): string {
		let out = this.serializer.serialize({ scrollback })
		if (out.length > maxLength) out = this.serializer.serialize({ scrollback: 0 })
		return out.length > maxLength ? '' : out
	}

	/** Whether the program asked for bracketed paste, so the real terminal can be told to send it. */
	bracketedPaste(): boolean {
		return this.term.modes.bracketedPasteMode
	}

	/** Replies the emulator makes to the program's terminal queries (cursor position, attributes). */
	onResponse(listener: (data: string) => void): { dispose(): void } {
		return this.term.onData(listener)
	}

	/** The visible rows as plain text, trailing blanks trimmed. */
	lines(): string[] {
		const buffer = this.term.buffer.active
		const rows: string[] = []
		for (let row = 0; row < this.term.rows; row++)
			rows.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
		return rows
	}

	/** Rows of history above the visible screen. */
	scrollbackSize(): number {
		return this.term.buffer.active.baseY
	}

	/** The visible screen as cells for the host's renderer, `back` rows into the scrollback. */
	cells(back = 0): CellSource {
		return xtermSource(this.term, this.cursorVisible, back)
	}

	dispose(): void {
		this.serializer.dispose()
		this.term.dispose()
	}
}
