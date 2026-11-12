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

/** The same rows from scratch: `up` rows above the cursor are erased first, then `statics`, then `rows`. */
function paintWhole(up: number, statics: string, rows: readonly string[]): string {
	let out = up > 0 ? `${ESC}[${up}A\r${ESC}[J` : ''
	if (statics !== '') out += crlf(statics)
	for (const row of rows) out += `${row}${row.includes(ESC) ? RESET : ''}\r\n`
	return out
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
		let data: string
		if (reflow !== null || fresh || statics !== '') {
			const up = reflow !== null ? reflow.rows : fresh ? 0 : shown.length
			data = (fresh ? '\r\n' : '') + paintWhole(up, statics, rows)
		} else data = paintChange(shown, rows)
		reflow = null
		fresh = false
		shown = rows
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
		lastFrame = null
		out(BSU + parts.join('') + ESU)
	}

	const take = (parts: string[]): void => {
		if (bypass()) {
			verbatim(parts)
			return
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
