/**
 * The two streams Ink is mounted on.
 *
 * In `direct` mode they are the real terminal: every write, size, event and
 * read goes to the real stream unchanged, so output is byte-identical to
 * mounting Ink on `process.stdout` and `process.stdin`.
 *
 * In `zoomed` mode (see `local.ts`) the output proxy sends Ink's writes to a
 * sink instead of the terminal and reports another size, and the input proxy
 * hands keys to a handler that decides which ones Ink gets. This module is
 * loaded at startup, so it holds only the switch; the emulator, the frame code
 * and the zoom logic are imported on the first zoom.
 */

import { EventEmitter } from 'node:events'

export interface ZoomedOutput {
	/** Receives what Ink writes while zoomed. */
	write(chunk: string): void
	columns: number
	rows: number
}

export interface TerminalProxy {
	readonly stdout: NodeJS.WriteStream
	readonly stdin: NodeJS.ReadStream
	readonly mode: 'direct' | 'zoomed'
	/** Whether the last cursor visibility sequence Ink wrote hid the cursor. */
	readonly cursorHidden: boolean
	/** Whether the last bracketed-paste sequence Ink wrote turned the mode on. */
	readonly bracketedPaste: boolean
	/** Switch output to `output`; Ink is told the new size with a `resize`. */
	enterZoomed(output: ZoomedOutput, onKey: (chunk: string) => string | null): void
	/** Switch back to the real terminal; Ink is told the real size with a `resize`. */
	leaveZoomed(): void
	/** A new size for the zoomed output (Ink re-lays out). */
	resizeZoomed(columns: number, rows: number): void
	/** Real terminal resizes while zoomed go here instead of reaching Ink; returns how to stop listening. */
	onRealResize(listener: () => void): () => void
	/** Hands Ink a key as if the terminal had sent it. */
	inject(chunk: string): void
}

const HIDE = '\u001b[?25l'
const SHOW = '\u001b[?25h'
const PASTE_ON = '\u001b[?2004h'
const PASTE_OFF = '\u001b[?2004l'
const RESIZE = 'resize'

export function createTerminalProxy(
	realOut: NodeJS.WriteStream,
	realIn: NodeJS.ReadStream,
): TerminalProxy {
	let zoomed: ZoomedOutput | null = null
	let keyHandler: ((chunk: string) => string | null) | null = null
	const realResizes = new Set<() => void>()
	const injected: string[] = []
	let announced = false
	let cursorHidden = false
	let bracketedPaste = false
	const resizes = new EventEmitter()
	let subscribed = false

	const noteModes = (chunk: unknown): void => {
		if (typeof chunk !== 'string') return
		if (chunk.includes('\u001b[?25')) {
			const hide = chunk.lastIndexOf(HIDE)
			const show = chunk.lastIndexOf(SHOW)
			if (hide !== show) cursorHidden = hide > show
		}
		if (chunk.includes('\u001b[?2004')) {
			const on = chunk.lastIndexOf(PASTE_ON)
			const off = chunk.lastIndexOf(PASTE_OFF)
			if (on !== off) bracketedPaste = on > off
		}
	}

	const subscribe = (): void => {
		if (subscribed) return
		subscribed = true
		realOut.on(RESIZE, () => {
			if (zoomed) for (const listener of [...realResizes]) listener()
			else resizes.emit(RESIZE)
		})
	}

	const out = new Proxy(realOut, {
		get(target, prop) {
			if (prop === 'write') {
				return (chunk: unknown, ...rest: unknown[]): boolean => {
					noteModes(chunk)
					if (zoomed === null)
						return Reflect.apply(target.write, target, [chunk, ...rest]) as boolean
					zoomed.write(typeof chunk === 'string' ? chunk : String(chunk))
					const done = rest.find((r) => typeof r === 'function') as (() => void) | undefined
					done?.()
					return true
				}
			}
			if (prop === 'columns') return zoomed ? zoomed.columns : target.columns
			if (prop === 'rows') return zoomed ? zoomed.rows : target.rows
			if (prop === 'getWindowSize') {
				return () => (zoomed ? [zoomed.columns, zoomed.rows] : target.getWindowSize())
			}
			if (
				prop === 'on' ||
				prop === 'addListener' ||
				prop === 'once' ||
				prop === 'off' ||
				prop === 'removeListener'
			) {
				return (event: string | symbol, listener: (...a: unknown[]) => void): unknown => {
					if (event !== RESIZE) {
						Reflect.apply(target[prop], target, [event, listener])
						return out
					}
					subscribe()
					resizes[prop](event, listener)
					return out
				}
			}
			const value = Reflect.get(target, prop, target) as unknown
			return typeof value === 'function' ? value.bind(target) : value
		},
	})

	const inn = new Proxy(realIn, {
		get(target, prop) {
			if (prop === 'read') {
				return (...args: unknown[]): unknown => {
					// A chunk the zoom code consumed is skipped by reading on: only a read that
					// returns null tells the stream to raise 'readable' again.
					for (;;) {
						const next = injected.shift()
						if (next !== undefined) return next
						const chunk = Reflect.apply(target.read, target, args) as unknown
						if (typeof chunk !== 'string') return chunk
						if (zoomed !== null && keyHandler !== null) {
							const kept = keyHandler(chunk)
							if (kept !== null) return kept
							continue
						}
						return chunk
					}
				}
			}
			const value = Reflect.get(target, prop, target) as unknown
			return typeof value === 'function' ? value.bind(target) : value
		},
	})

	return {
		stdout: out as NodeJS.WriteStream,
		stdin: inn as NodeJS.ReadStream,
		get mode() {
			return zoomed ? 'zoomed' : 'direct'
		},
		get cursorHidden() {
			return cursorHidden
		},
		get bracketedPaste() {
			return bracketedPaste
		},
		enterZoomed(output, onKey) {
			zoomed = output
			keyHandler = onKey
			resizes.emit(RESIZE)
		},
		leaveZoomed() {
			zoomed = null
			keyHandler = null
			resizes.emit(RESIZE)
		},
		resizeZoomed(columns, rows) {
			if (!zoomed) return
			zoomed.columns = columns
			zoomed.rows = rows
			resizes.emit(RESIZE)
		},
		onRealResize(listener) {
			realResizes.add(listener)
			subscribe()
			return () => {
				realResizes.delete(listener)
			}
		},
		inject(chunk) {
			injected.push(chunk)
			if (announced) return
			announced = true
			// Ink reads on 'readable'; nothing else would tell it a key is waiting.
			queueMicrotask(() => {
				announced = false
				if (injected.length > 0) realIn.emit('readable')
			})
		},
	}
}
