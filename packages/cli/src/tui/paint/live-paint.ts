/**
 * Paints the default screen's live region by what changed.
 *
 * Ink in its plain mode erases the whole live region and writes it again on every frame,
 * and on a resize the app used to clear the terminal and its scrollback and print the whole
 * conversation again. This stream sits between Ink and the terminal and takes over the
 * writing, so that:
 *
 * - a frame writes only the rows, and inside a row only the cells, that differ from what is
 *   on screen, and nothing at all when nothing differs;
 * - frames are painted at most `FRAME_MS` apart; the ones in between are folded into the
 *   next, and rows meant to be printed once above the region are kept, in order;
 * - a resize is taken from Ink until it has settled, then the region is erased by the number
 *   of rows the terminal made of it at the new width, and one whole frame is drawn. Rows
 *   already printed above are never touched;
 * - leaving shows the cursor and leaves it at the start of a line under the last frame,
 *   also when the process ends without unmounting and when it is continued after a stop.
 *
 * What Ink writes in its plain mode is, between `ESC[?2026h` and `ESC[?2026l`, either one
 * part (the erase of the last frame and the frame) or several (the erase, text to print once,
 * the frame). The frame is the last text part. Ink's own erase counts are ignored: this
 * module keeps its own model of what is on screen. A block of any other shape is passed
 * through whole and the model is dropped.
 *
 * The default screen only. Fullscreen redraws on the alternate screen and keeps Ink's own
 * writer.
 */

import { EventEmitter } from 'node:events'

import { rowWidth, writeRowChange } from './cells.js'

const ESC = '\u001b'
const BSU = `${ESC}[?2026h`
const ESU = `${ESC}[?2026l`
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`
const RESET = `${ESC}[0m`
const RESIZE = 'resize'
const TAIL = 256

/** The most paints a second. */
export const FRAMES_PER_SECOND = 12
export const FRAME_MS = 1000 / FRAMES_PER_SECOND
/** A resize is acted on this long after the last event of a burst. */
export const RESIZE_SETTLE_MS = 150
/** After Ink is told the new size, frames are held this long so the one drawn at that size lands. */
export const RESIZE_HOLD_MS = 100

/** `eraseLines(n)` as Ink writes it. */
const ERASE_PREFIX = new RegExp(`^(?:${ESC}\\[2K(?:${ESC}\\[1A)?)+${ESC}\\[G`)
const CURSOR_MODE = new RegExp(`^${ESC}\\[\\?25[lh]$`)
/** What Ink writes ahead of a frame it cannot paint in place: clear everything, then all it ever printed. */
const CLEAR_TERMINAL = `${ESC}[2J${ESC}[3J${ESC}[H`
/** Writes that change no row and so need nothing painted before them: titles and clipboard marks. */
const BENIGN = new RegExp(`^(?:${ESC}\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\))+$`)
/** Writes that leave the screen unlike what the model holds. */
const SCREEN_CHANGE = new RegExp(`${ESC}\\[[0-3]?J|${ESC}\\[H|${ESC}c|${ESC}\\[\\?1049[hl]`)

export interface LivePaintTimers {
	now(): number
	set(run: () => void, ms: number): unknown
	clear(handle: unknown): void
}

export interface LivePaintOptions {
	/** Whether Ink's output is being mirrored elsewhere (the workspaces screen): written as Ink wrote it. */
	readonly bypass?: () => boolean
	readonly timers?: LivePaintTimers
	/** The process the hooks go on; none for a test that has its own. */
	readonly process?: Pick<NodeJS.Process, 'on' | 'off'> | null
}

export interface LivePaint {
	/** What Ink is mounted on. */
	readonly stream: NodeJS.WriteStream
	/** Paints whatever is waiting, now. */
	flush(): void
	/** Paints what is waiting, shows the cursor, and lets go of the terminal. */
	dispose(): void
}

const realTimers: LivePaintTimers = {
	now: () => Date.now(),
	set: (run, ms) => {
		const handle = setTimeout(run, ms)
		handle.unref()
		return handle
	},
	clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

interface Pending {
	/** Text Ink printed once above the region, in order. */
	statics: string
	/** The latest frame, row by row; null when only a hidden-cursor mark came. */
	rows: string[] | null
}

const lines = (frame: string): string[] => {
	const rows = frame.split('\n')
	rows.pop()
	return rows
}

const crlf = (text: string): string => {
	const fixed = text.replace(/\r?\n/g, '\r\n')
	return fixed.endsWith('\n') ? fixed : `${fixed}\r\n`
}

/**
 * The write that turns the rows on screen into `next`: a cursor at the start of the line
 * under `shown`, and left at the start of the line under `next`.
 */
export function paintChange(shown: readonly string[], next: readonly string[]): string {
	const s = shown.length
	const n = next.length
	let out = ''
	let at = s
	const go = (row: number): void => {
		if (row < at) out += `${ESC}[${at - row}A`
		else if (row > at) out += `${ESC}[${row - at}B`
		at = row
	}
	for (let i = 0; i < Math.min(s, n); i++) {
		const was = shown[i] as string
		const now = next[i] as string
		if (was === now) continue
		go(i)
		out += writeRowChange(was, now)
	}
	if (n > s) {
		go(s)
		for (let i = s; i < n; i++) {
			const row = next[i] as string
			out += `\r${row}${row.includes(ESC) ? RESET : ''}\r\n`
		}
	} else if (out !== '') {
		go(n)
		out += n < s ? `\r${ESC}[J` : '\r'
	} else if (n < s) {
		go(n)
		out += `\r${ESC}[J`
	}
	return out
}

/**
 * Whether a frame that is shorter than the one on screen only lost rows above its bottom: the rows
 * above its last one are the old frame's rows at the same distance from the end. The working line,
 * the live end of a reply, the plan and the calls above the input box leave this way when a turn
 * ends (the last row, the status line, is not compared: it says other things between turns); a
 * menu closing under the box does not.
 */
export function lostRowsAbove(shown: readonly string[], next: readonly string[]): boolean {
	if (next.length < 2 || next.length >= shown.length) return false
	const check = Math.min(next.length - 1, 3)
	for (let back = 1; back <= check; back++)
		if (next[next.length - 1 - back] !== shown[shown.length - 1 - back]) return false
	return true
}

/**
 * A region that kept its height while it lost rows above its bottom: the screen holds `height`
 * rows however many rows Ink draws, and the blank rows that make up the difference lie just above
 * the last `suffix` rows (the input box and the status line), so the box keeps its place.
 */
export interface Pin {
	readonly height: number
	/** The rows Ink last drew, without the blank rows. */
	readonly ink: readonly string[]
	readonly suffix: number
}

/** `rows` with the blank rows of `pin` put above its last `suffix` rows. */
export function pinnedRows(rows: readonly string[], pin: Pin | null): readonly string[] {
	if (pin === null) return rows
	const blank = pin.height - rows.length
	if (blank <= 0) return rows
	const at = Math.max(0, rows.length - pin.suffix)
	return [...rows.slice(0, at), ...new Array<string>(blank).fill(''), ...rows.slice(at)]
}

/** The turn has just ended and the region has not shrunk since: its next shrink may start a pin. */
let turnJustEnded = false

/**
 * The turn ended: the working line, the plan and the calls are about to leave the live region. The
 * next time the region gets shorter by rows above its bottom it keeps its height, so the input box
 * stays where it was while the turn ran (`NAMZU_BOX_AT_BOTTOM=0` leaves the box where the shorter region ends instead). Called from the render that shows the idle state, so it is
 * known before the frame that shrinks is painted.
 */
export function noteTurnEnded(): void {
	turnJustEnded = process.env.NAMZU_BOX_AT_BOTTOM !== '0'
}

/** A turn began: nothing is waiting to be pinned. */
export function noteTurnStarted(): void {
	turnJustEnded = false
}

/**
 * What the pin is after a frame. A region that loses rows above its bottom right after a turn
 * ended (`start`) starts one, at the height it had; while it lasts, frames of the same height change the rows in place and a frame
 * that is taller or shorter with the same last rows keeps the height; any other frame (a menu
 * opening, a taller region than the pinned height) lets it go, and so does a resize or a clear.
 */
export function nextPin(
	pin: Pin | null,
	shown: readonly string[],
	rows: readonly string[],
	screenRows: number,
	start: boolean,
): Pin | null {
	if (screenRows <= 0) return null
	if (pin !== null) {
		if (rows.length === pin.ink.length) return { ...pin, ink: rows }
		if (rows.length < pin.height && (lostRowsAbove(pin.ink, rows) || lostRowsAbove(rows, pin.ink)))
			return { height: pin.height, ink: rows, suffix: Math.min(rows.length, pin.suffix) }
		return null
	}
	if (start && shown.length < screenRows - 1 && lostRowsAbove(shown, rows))
		return { height: shown.length, ink: rows, suffix: Math.min(rows.length, 4) }
	return null
}

/**
 * One line written over what is there: its text, then the rest of the physical row cleared, so
 * the old line shows until this one is on it and no row is ever blank in between. A line that
 * fills its last row to the edge needs no clearing (and the cursor waits at the edge, where a
 * clear would take the last cell).
 */
function overLine(line: string, columns: number): string {
	const width = rowWidth(line)
	const colours = line.includes(ESC)
	const filled = width > 0 && width % Math.max(1, columns) === 0
	return `${line}${colours ? RESET : ''}${filled ? '' : `${ESC}[K`}\r\n`
}

/**
 * The same rows from scratch: the cursor goes `up` rows to the top of what is on screen, and
 * `statics` and then `rows` are written over it line by line (each clears only its own row's
 * remainder), and whatever of the old region is left under them is erased at the end. Nothing
 * is erased before it is drawn over, so without synchronized output the bottom of the screen
 * is never blank, only a mix of old and new rows for a moment.
 *
 * When there are more new lines than old rows and every line fits one row, the lines past the
 * old rows are written first, under the old region (the screen scrolls for them), and then the
 * old rows are written over from the bottom up. The composer and status rows are so never
 * overwritten before their new rows stand under them: without synchronized output a row of each
 * is on screen at every step.
 */
function paintWhole(
	upRows: number,
	statics: string,
	rows: readonly string[],
	columns: number,
	screenRows: number,
	oneRowEach: boolean,
	scrolled: ((all: readonly string[]) => number) | null = null,
): string {
	let up = upRows
	let all: string[] = []
	if (statics !== '') {
		for (const line of lines(statics.endsWith('\n') ? statics : `${statics}\n`))
			all.push(line.replace(/\r$/, ''))
	}
	all.push(...rows)
	if (scrolled !== null) {
		// The old region's top rows are in scrollback already: start under them, from the top of the screen.
		const skip = scrolled(all)
		if (skip > 0) {
			all = all.slice(skip)
			up = Math.max(0, Math.min(up, screenRows - 1))
		}
	}
	const write = (from: number, to: number): string => {
		let data = ''
		for (let i = from; i < to; i++) data += overLine(all[i] as string, columns)
		return data
	}
	const total = all.length
	const fits = oneRowEach && all.every((line) => rowWidth(line) <= columns)
	if (up > 0 && fits && total > up && total <= screenRows) {
		// The lines past the old rows first (under the region), then the old rows from the bottom up:
		// the new composer and status rows stand under the old ones before the old ones are overwritten.
		let data = write(up, total)
		let at = total
		for (let row = up - 1; row >= 0; row--) {
			data += `${ESC}[${at - row}A${overLine(all[row] as string, columns)}`
			at = row + 1
		}
		return `${data}${ESC}[${total - at}B`
	}
	return `${up > 0 ? `${ESC}[${up}A\r` : ''}${write(0, total)}${up > 0 ? `${ESC}[J` : ''}`
}

/**
 * What starts the terminal UI on a fresh line without erasing anything: nothing shows when the cursor
 * is already at the start of a line; when a program left it mid-line, a mark ends that line (as shells
 * do) and the cursor lands at the start of the next one. Never a newline written blindly, which
 * would leave a blank line under every normal launch.
 */
export function startOnFreshLine(columns: number): string {
	const width = Math.max(1, columns)
	return `${ESC}[7m%${ESC}[27m${' '.repeat(width - 1)}\r${ESC}[K`
}

/** A row's text without its colour sequences and link marks. */
const plainText = (row: string): string =>
	row.replace(
		new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]|${ESC}\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)`, 'g'),
		'',
	)

/**
 * The text of the first `rows` terminal rows `lines` take at `columns`, or null when that count
 * would end inside a line (or the lines are too few).
 */
function textOfFirstRows(lines: readonly string[], rows: number, columns: number): string[] | null {
	const width = Math.max(1, columns)
	const taken: string[] = []
	let used = 0
	for (const line of lines) {
		if (used === rows) return taken
		used += Math.max(1, Math.ceil(rowWidth(line) / width))
		if (used > rows) return null
		taken.push(plainText(line))
	}
	return used === rows ? taken : null
}

/**
 * How many lines at the start of `all` are already in the terminal's scrollback. A terminal that
 * is made shorter than the region it holds pushes the region's top rows into scrollback before
 * they can be erased; when the lines about to be written start with exactly those rows (the rows
 * of the old region, then the ones printed since), writing them again would print them twice.
 * Zero when the terminal did not do that or the lines are not those rows.
 */
export function linesAlreadyScrolled(
	shown: readonly string[],
	all: readonly string[],
	regionRows: number,
	screenRows: number,
	columns: number,
): number {
	if (screenRows <= 0) return 0
	const gone = regionRows - (screenRows - 1)
	if (gone <= 0) return 0
	const old = textOfFirstRows(shown, gone, columns)
	const next = textOfFirstRows(all, gone, columns)
	if (old === null || next === null || old.join('\n') !== next.join('\n')) return 0
	return next.length
}

/** How many rows `rows` take on a terminal `columns` wide that has reflowed them. */
export function reflowedRows(rows: readonly string[], columns: number): number {
	const width = Math.max(1, columns)
	let total = 0
	for (const row of rows) total += Math.max(1, Math.ceil(rowWidth(row) / width))
	return total
}

export function createLivePaint(
	target: NodeJS.WriteStream,
	options: LivePaintOptions = {},
): LivePaint {
	const timers = options.timers ?? realTimers
	const bypass = options.bypass ?? (() => false)
	const hooks = options.process === undefined ? process : options.process
	const listeners = new EventEmitter()
	let shown: string[] = []
	let lastFrame: string[] | null = null
	let pending: Pending | null = null
	let block: string[] | null = null
	/** Ink asked for the cursor to be hidden, and the terminal has been told so. */
	let hideAsked = false
	let hidden = false
	let lastPaint = Number.NEGATIVE_INFINITY
	let frameTimer: unknown = null
	let settleTimer: unknown = null
	let holdTimer: unknown = null
	let holding = false
	let resizing = false
	let reflow: { rows: number } | null = null
	let fresh = false
	/** Set while the region keeps its height after losing rows above its bottom, so the input box stays put. */
	let pin: Pin | null = null
	/** Ink cleared the terminal and wrote everything again: the next frame's erase count says how tall its last frame was. */
	let adopt = false
	let disposed = false
	/** How much text Ink has printed above the region, so a clear-and-print-all frame can be cut back to its frame. */
	let printed = { length: 0, tail: '' }

	const out = (data: string): void => {
		if (data !== '') target.write(data)
	}

	const stop = (handle: unknown): null => {
		if (handle !== null) timers.clear(handle)
		return null
	}

	const paint = (): void => {
		frameTimer = stop(frameTimer)
		const job = pending
		pending = null
		const rows = job?.rows ?? (reflow !== null || fresh ? lastFrame : null)
		if (rows === null) {
			if (job?.statics) out(BSU + crlf(job.statics) + ESU)
			return
		}
		const statics = job?.statics ?? ''
		const screenRows = target.rows ?? 0
		const settled = reflow === null && !fresh
		pin = settled ? nextPin(pin, shown, rows, screenRows, turnJustEnded) : null
		// The hint is for the first change of height after the turn.
		if (settled && rows.length !== shown.length) turnJustEnded = false
		const drawn = pinnedRows(rows, pin)
		let data: string
		if (reflow !== null || fresh || statics !== '') {
			const up = reflow !== null ? reflow.rows : fresh ? 0 : shown.length
			const columns = target.columns ?? 80
			const oldRows = shown
			const regionRows = up
			data =
				(fresh ? '\r\n' : '') +
				paintWhole(
					up,
					statics,
					drawn,
					columns,
					screenRows,
					reflow === null,
					reflow !== null
						? (all) => linesAlreadyScrolled(oldRows, all, regionRows, screenRows, columns)
						: null,
				)
		} else data = paintChange(shown, drawn)
		reflow = null
		fresh = false
		shown = [...drawn]
		if (data === '') return
		lastPaint = timers.now()
		const hide = hideAsked && !hidden
		hidden = hidden || hide
		out(BSU + (hide ? HIDE_CURSOR : '') + data + ESU)
	}

	const schedule = (): void => {
		if (holding || resizing || pending === null || frameTimer !== null) return
		const wait = lastPaint + FRAME_MS - timers.now()
		if (wait <= 0) paint()
		else {
			frameTimer = timers.set(() => {
				frameTimer = null
				// A frame waiting its turn is held while the size is moving, and painted once it has settled.
				if (!holding && !resizing) paint()
			}, wait)
		}
	}

	const flush = (): void => {
		holdTimer = stop(holdTimer)
		holding = false
		if (pending !== null || reflow !== null || fresh) paint()
	}

	const verbatim = (parts: readonly string[]): void => {
		flush()
		shown = []
		pin = null
		lastFrame = null
		out(BSU + parts.join('') + ESU)
	}

	const take = (parts: string[]): void => {
		if (bypass()) {
			verbatim(parts)
			return
		}
		if (adopt) {
			// What Ink wrote last (a clear and a reprint, passed through whole) ended with its frame on screen. The erase
			// it now asks for is that frame's height: the region is that many rows, drawn again under one paint.
			adopt = false
			const first = parts.find((part) => part !== '')
			if (first !== undefined && ERASE_PREFIX.test(first)) {
				const rows = (first.match(new RegExp(`${ESC}\\[2K`, 'g')) ?? []).length - 1
				if (rows > 0) reflow = { rows }
			}
		}
		const texts: string[] = []
		for (const part of parts) {
			if (part === '') continue
			if (CURSOR_MODE.test(part)) {
				hideAsked = part === HIDE_CURSOR
				if (!hideAsked) {
					flush()
					out(part)
					hidden = false
				}
				continue
			}
			const text = part.replace(ERASE_PREFIX, '')
			if (text !== '') texts.push(text)
		}
		// A clear that comes as a write of its own, then the whole conversation and the frame in the next: the
		// conversation was replaced (a compaction, a resumed or cleared one). It is passed through as Ink wrote it.
		if (texts.length > 1 && texts.slice(0, -1).some((text) => text.startsWith(CLEAR_TERMINAL))) {
			// The scrollback is the person's, from before this program started as much as from after: the screen's
			// rows are pushed into it, and only the screen is cleared (never the scrollback).
			const push = '\n'.repeat(Math.max(0, target.rows ?? 0))
			verbatim(
				parts.map((part) =>
					part.startsWith(CLEAR_TERMINAL)
						? `${push}${ESC}[2J${ESC}[H${part.slice(CLEAR_TERMINAL.length)}`
						: part,
				),
			)
			printed = { length: 0, tail: '' }
			adopt = true
			reflow = null
			return
		}
		let frame = texts.pop()
		if (frame === undefined) return
		if (frame.startsWith(CLEAR_TERMINAL)) {
			// Ink's answer to a live region taller than the terminal was, once, to clear the terminal and the
			// scrollback and print every row again: what a resize to fewer rows asks of it, for the frames it
			// drew before it knew the new size. What was printed is on screen already and stays there; only the
			// frame, which Ink writes last and without its newline, is kept.
			const rest = frame.slice(CLEAR_TERMINAL.length)
			const n = printed.length
			if (n > 0 && rest.slice(Math.max(0, n - printed.tail.length), n) !== printed.tail) {
				verbatim(parts)
				return
			}
			frame = `${rest.slice(n)}\n`
		}
		if (frame.includes(`${ESC}[2J`)) {
			verbatim(parts)
			return
		}
		// A frame as tall as the terminal comes without its newline; the region is drawn the same way.
		if (!frame.endsWith('\n')) frame += '\n'
		for (const text of texts) {
			if (text.includes(`${ESC}[2J`)) printed = { length: 0, tail: '' }
			else if (text.endsWith('\n')) {
				printed = { length: printed.length + text.length, tail: (printed.tail + text).slice(-TAIL) }
			}
		}
		const statics = texts.join('')
		const rows = lines(frame)
		lastFrame = rows
		pending = { statics: (pending?.statics ?? '') + statics, rows }
		schedule()
	}

	const settle = (): void => {
		settleTimer = null
		resizing = false
		reflow = { rows: reflowedRows(shown, target.columns ?? 80) }
		holding = true
		listeners.emit(RESIZE)
		holdTimer = timers.set(() => {
			holdTimer = null
			holding = false
			paint()
		}, RESIZE_HOLD_MS)
	}

	const onTargetResize = (): void => {
		if (disposed) return
		if (bypass()) {
			listeners.emit(RESIZE)
			return
		}
		holdTimer = stop(holdTimer)
		holding = false
		reflow = null
		resizing = true
		settleTimer = stop(settleTimer)
		settleTimer = timers.set(settle, RESIZE_SETTLE_MS)
	}
	target.on(RESIZE, onTargetResize)

	const doneWith = (rest: readonly unknown[]): void => {
		const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined
		if (cb) queueMicrotask(cb)
	}

	const write = (chunk: unknown, ...rest: unknown[]): boolean => {
		if (disposed || typeof chunk !== 'string') {
			if (!disposed) flush()
			return Reflect.apply(target.write, target, [chunk, ...rest]) as boolean
		}
		if (chunk === BSU) {
			if (block !== null) verbatim(block)
			block = []
			doneWith(rest)
			return true
		}
		if (block !== null) {
			if (chunk === ESU) {
				const parts = block
				block = null
				take(parts)
			} else block.push(chunk)
			doneWith(rest)
			return true
		}
		// Ink erasing its last frame (a narrower terminal): this module erases by its own count.
		if (ERASE_PREFIX.test(chunk) && chunk.replace(ERASE_PREFIX, '') === '') {
			doneWith(rest)
			return true
		}
		if (chunk !== '' && !BENIGN.test(chunk)) {
			// A frame waiting its turn goes first, unless the size is still moving.
			if (!holding && !resizing) flush()
			if (chunk.includes(HIDE_CURSOR) || chunk.includes(SHOW_CURSOR)) {
				hidden = chunk.lastIndexOf(HIDE_CURSOR) > chunk.lastIndexOf(SHOW_CURSOR)
				hideAsked = hidden
			}
			if (SCREEN_CHANGE.test(chunk)) {
				shown = []
				pin = null
				reflow = null
			}
		}
		return Reflect.apply(target.write, target, [chunk, ...rest]) as boolean
	}

	const stream = new Proxy(target, {
		get(base, prop) {
			if (prop === 'write') return write
			if (
				prop === 'on' ||
				prop === 'addListener' ||
				prop === 'once' ||
				prop === 'off' ||
				prop === 'removeListener'
			) {
				return (event: string | symbol, listener: (...a: unknown[]) => void): unknown => {
					if (event !== RESIZE) {
						Reflect.apply(base[prop], base, [event, listener])
						return stream
					}
					listeners[prop](event, listener)
					return stream
				}
			}
			const value = Reflect.get(base, prop, base) as unknown
			return typeof value === 'function' ? value.bind(base) : value
		},
	}) as NodeJS.WriteStream

	// A process that ends without unmounting still gives the terminal back: the last frame
	// is painted and the cursor shown.
	const onExit = (): void => {
		if (!disposed) leave()
	}
	// Continued after a stop the shell has drawn under the frame: start a fresh one below it.
	const onContinue = (): void => {
		if (disposed || bypass()) return
		shown = []
		pin = null
		fresh = true
		reflow = null
		hidden = false
		if (lastFrame !== null) paint()
	}
	hooks?.on('exit', onExit)
	hooks?.on('SIGCONT', onContinue)

	function leave(): void {
		settleTimer = stop(settleTimer)
		holdTimer = stop(holdTimer)
		frameTimer = stop(frameTimer)
		holding = false
		resizing = false
		if (block !== null) {
			const parts = block
			block = null
			take(parts)
		}
		if (pending !== null || reflow !== null || fresh) paint()
		if (hidden) out(SHOW_CURSOR)
		hidden = false
		hideAsked = false
	}

	return {
		stream,
		flush,
		dispose() {
			if (disposed) return
			leave()
			disposed = true
			target.off(RESIZE, onTargetResize)
			hooks?.off('exit', onExit)
			hooks?.off('SIGCONT', onContinue)
		},
	}
}
