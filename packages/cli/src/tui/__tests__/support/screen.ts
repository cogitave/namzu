/**
 * Render the TUI into an emulated terminal and read the SCREEN back.
 *
 * ## What the frame-string surface cannot say
 *
 * Every TUI test here renders through a test renderer and asserts on frame
 * strings. A frame string has no row geometry, no scrollback and no byte
 * count, so it cannot distinguish "printed again below" from "rewritten in
 * place" — and that distinction is not academic. A defect this repository
 * already found turned on exactly it: pressing the expand key produced one
 * further frame whose transcript region was byte-identical to the previous
 * one, and only a screen-level observation could say so.
 *
 * A frame string also cannot express "the bottom row". It is a blob of text
 * with no notion of where the viewport ends, so `toContain('Ctrl+C')` passes
 * whether the status bar is one row or two, on the last row or the first.
 *
 * ## What this gives instead
 *
 * The renderer's stdout is a **headless terminal emulator** — the same VT
 * parser a terminal uses, with no display attached. It interprets the cursor
 * moves and erase sequences the renderer emits, so what comes back is the
 * screen an operator would be looking at, not the bytes on the way to it:
 *
 *  - {@link Screen.viewport} / {@link Screen.row} — the visible rows, indexable
 *    from the bottom.
 *  - {@link Screen.scrollback} — everything, including what has scrolled off.
 *  - {@link Screen.cursor} and {@link Screen.bufferType} — where the cursor
 *    landed, and whether the app took the alternate screen (it must not: the
 *    transcript has to survive in the operator's scrollback).
 *  - {@link Screen.bytesWritten} — "it repainted in place" is a description
 *    until something counts bytes.
 *
 * ## Production-shaped on purpose
 *
 * The shipped test renderer runs the renderer in debug mode, which emits every
 * update as a fresh full frame with no erase sequences at all. That is a
 * different renderer from the one that ships, and a fixture unlike production
 * tests a system that does not ship — see
 * `docs/conventions/fixture-must-match-production.md`. So this drives the real
 * `render` with `interactive: true` and the production frame-rate cap, which
 * is what puts the in-place repaint on the wire in the first place.
 *
 * That cap is also why {@link Screen.waitForRender} exists. Fixed waits have
 * caused three separate flakes in this suite, every one of them in scaffolding
 * rather than in a test — so there is no duration in this file, and no test
 * written against it should introduce one. The renderer can be asked to SETTLE
 * its throttle, which fires the pending frame immediately; sleeping past the
 * throttle window would reach the same frame by the one mechanism already
 * known to go red under load.
 */

import { EventEmitter } from 'node:events'

import { Terminal } from '@xterm/headless'
import { type Instance, render } from 'ink'
import type { ReactElement } from 'react'

/** Geometry and timing the emulated terminal is built with. */
export interface ScreenOptions {
	/** Terminal width. */
	readonly cols?: number
	/** Terminal height — the number of rows a viewport read returns. */
	readonly rows?: number
	/**
	 * Frame-rate cap handed to the renderer. Defaults to what ships, so a test
	 * exercises the throttled renderer rather than an unthrottled one that
	 * behaves differently. {@link Screen.waitForRender} settles the throttle
	 * rather than waiting it out, so raising this does not make tests faster
	 * and lowering it does not make them slower.
	 */
	readonly maxFps?: number
	/** How many rows of scrollback the emulator keeps. */
	readonly scrollback?: number
	/**
	 * Mount on the terminal's alternate screen.
	 *
	 * Nothing this repository ships does, and nothing should — the transcript
	 * has to survive in the operator's scrollback. It is settable so that
	 * {@link Screen.bufferType} can be shown to distinguish the two: an
	 * assertion that the app stayed on the normal screen proves nothing if the
	 * reader has no way to ever say otherwise.
	 */
	readonly alternateScreen?: boolean
}

/** Where the cursor is, in viewport coordinates. */
export interface CursorPosition {
	readonly col: number
	readonly row: number
}

/** A mounted app plus readers for the screen it is drawing on. */
export interface Screen {
	/** The visible rows, top to bottom, with trailing blanks trimmed per row. */
	viewport(): string[]
	/**
	 * One visible row. Negative indexes count from the bottom, so `row(-1)` is
	 * the bottom row — the assertion a frame string cannot express.
	 */
	row(index: number): string
	/** Every row the emulator holds, scrollback first. */
	scrollback(): string[]
	cursor(): CursorPosition
	/**
	 * `'alternate'` once the app has taken the alternate screen. A TUI that
	 * does is one whose transcript never reaches the operator's scrollback.
	 */
	bufferType(): 'normal' | 'alternate'
	/** Total bytes the renderer has written to stdout since mount. */
	bytesWritten(): number
	/** Every write, in order. The raw bytes, before the emulator interpreted them. */
	writes(): readonly string[]
	/** Whether Ink currently owns stdin in raw mode. */
	rawMode(): boolean
	/** Send input, as one keypress. */
	press(input: string): void
	/** Swap the mounted element. Follow with `await waitForRender()`. */
	rerender(node: ReactElement): void
	/**
	 * Settle: let the reconciler commit, settle the renderer's throttle so its
	 * pending frame is written now, and drain the emulator's parser. No
	 * duration anywhere in it.
	 */
	waitForRender(): Promise<void>
	unmount(): Promise<void>
}

/** The renderer's own default frame-rate cap. */
const DEFAULT_MAX_FPS = 30

/**
 * stdin the renderer will accept.
 *
 * One `write` is delivered as ONE keypress, which is why `press` is named for
 * a press: sending `'/expand\r'` in a single call arrives with the return key
 * unset and is taken as pasted text.
 */
class ScreenStdin extends EventEmitter {
	isTTY = true
	private data: string | null = null
	private raw = false

	press(input: string): void {
		this.data = input
		this.emit('readable')
		this.emit('data', input)
	}

	read(): string | null {
		const { data } = this
		this.data = null
		return data
	}

	setEncoding(): void {}
	setRawMode(value: boolean): void {
		this.raw = value
	}

	isRaw(): boolean {
		return this.raw
	}
	resume(): void {}
	pause(): void {}
	ref(): void {}
	unref(): void {}
}

/** stdout that forwards to the emulator and keeps the tally. */
class ScreenStdout extends EventEmitter {
	isTTY = true
	readonly columns: number
	readonly rows: number

	readonly chunks: string[] = []
	bytes = 0

	/** Writes the emulator's parser has not finished with. */
	private outstanding = 0
	private readonly waiters: (() => void)[] = []

	constructor(
		private readonly term: Terminal,
		cols: number,
		rows: number,
	) {
		super()
		this.columns = cols
		this.rows = rows
	}

	/**
	 * `callback` is not optional decoration: the renderer's flush writes an
	 * EMPTY string and waits on the callback to know the stream drained. A
	 * stdout that ignored it would hang that flush, which is the one call
	 * {@link Screen.waitForRender} is built on.
	 *
	 * The empty write is not recorded — it carries no output, and putting it in
	 * the log would make `writes()` count flushes as frames.
	 */
	write = (chunk: string, callback?: () => void): boolean => {
		if (chunk.length > 0) {
			this.chunks.push(chunk)
			this.bytes += Buffer.byteLength(chunk, 'utf8')
		}
		this.outstanding += 1
		this.term.write(chunk, () => {
			this.outstanding -= 1
			if (this.outstanding === 0) for (const done of this.waiters.splice(0)) done()
			callback?.()
		})
		return true
	}

	/** Resolves once the parser has consumed everything written so far. */
	drain(): Promise<void> {
		if (this.outstanding === 0) return Promise.resolve()
		return new Promise((resolve) => this.waiters.push(resolve))
	}
}

const immediate = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * Mount `node` on an emulated terminal of the given size.
 *
 * Resolves once the first frame is on the screen, so a caller reads without
 * an initial wait of its own.
 */
export async function renderToScreen(
	node: ReactElement,
	options: ScreenOptions = {},
): Promise<Screen> {
	const cols = options.cols ?? 80
	const rows = options.rows ?? 24
	const maxFps = options.maxFps ?? DEFAULT_MAX_FPS

	const term = new Terminal({
		cols,
		rows,
		scrollback: options.scrollback ?? 1_000,
		// A line feed alone moves DOWN, not down-and-left. On a real terminal
		// the line-discipline layer between the process and the emulator turns
		// it into a carriage return plus a line feed; there is no such layer
		// here, so the emulator does it. Without this every multi-row render
		// comes back as a staircase — which looks like a layout bug in the
		// component and is an artefact of the harness.
		convertEol: true,
		allowProposedApi: true,
	})
	const stdout = new ScreenStdout(term, cols, rows)
	const stdin = new ScreenStdin()

	const instance: Instance = render(node, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		stdin: stdin as unknown as NodeJS.ReadStream,
		stderr: stdout as unknown as NodeJS.WriteStream,
		// The two that make this the shipped renderer rather than the test one:
		// real erase sequences and the real frame-rate cap.
		debug: false,
		interactive: true,
		alternateScreen: options.alternateScreen ?? false,
		maxFps,
		exitOnCtrlC: false,
		patchConsole: false,
	})

	/**
	 * Settle, without a duration anywhere in it.
	 *
	 * The obvious implementation waits `1000 / maxFps` milliseconds for the
	 * throttle's trailing edge. It is also the wrong one, and measurably so:
	 * that is a fixed wait in scaffolding, which is what three separate flakes
	 * in this suite have been. The renderer instead exposes a way to SETTLE the
	 * throttle — force the pending trailing call to fire now — so the frame
	 * lands because it was flushed, not because enough time passed.
	 *
	 * Mutation-checked: removing the flush leaves both byte-counting cases red.
	 */
	const waitForRender = async (): Promise<void> => {
		// Let the reconciler commit and its passive effects run first, or the
		// flush below settles a throttle that has nothing queued yet.
		await immediate()
		await instance.waitUntilRenderFlush()
		await immediate()
		await stdout.drain()
	}

	const lineAt = (index: number): string =>
		term.buffer.active.getLine(index)?.translateToString(true) ?? ''

	const screen: Screen = {
		viewport: () => {
			// `baseY` is where the viewport starts inside the whole buffer; rows
			// below it are the visible ones and rows above are scrollback.
			const top = term.buffer.active.baseY
			return Array.from({ length: rows }, (_, i) => lineAt(top + i))
		},
		row: (index) => {
			const top = term.buffer.active.baseY
			const offset = index < 0 ? rows + index : index
			return lineAt(top + offset)
		},
		scrollback: () => Array.from({ length: term.buffer.active.length }, (_, i) => lineAt(i)),
		cursor: () => ({
			col: term.buffer.active.cursorX,
			row: term.buffer.active.cursorY,
		}),
		bufferType: () => term.buffer.active.type,
		bytesWritten: () => stdout.bytes,
		writes: () => stdout.chunks,
		rawMode: () => stdin.isRaw(),
		press: (input) => stdin.press(input),
		rerender: (next) => instance.rerender(next),
		waitForRender,
		unmount: async () => {
			instance.unmount()
			await instance.waitUntilExit().catch(() => {})
			instance.cleanup()
			await stdout.drain()
			term.dispose()
		},
	}

	await waitForRender()
	return screen
}
