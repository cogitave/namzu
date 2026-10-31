/**
 * The two streams Ink is mounted on.
 *
 * In `direct` mode they are the real terminal: every write, size, event and
 * read goes to the real stream unchanged, so output is byte-identical to
 * mounting Ink on `process.stdout` and `process.stdin`.
 *
 * In `zoomed` mode (see `zoom.ts`) the output proxy sends Ink's writes to a
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
	/** Switch output to `output`; Ink is told the new size with a `resize`. */
	enterZoomed(output: ZoomedOutput, onKey: (chunk: string) => string | null): void
	/** Switch back to the real terminal; Ink is told the real size with a `resize`. */
	leaveZoomed(): void
	/** A new size for the zoomed output (Ink re-lays out). */
	resizeZoomed(columns: number, rows: number): void
	/** Real terminal resizes while zoomed go here instead of reaching Ink. */
	onRealResize(listener: () => void): void
	/** Called when the debug key is read in direct mode. */
	setTrigger(key: string, trigger: () => void): void
}

const HIDE = '\u001b[?25l'
const SHOW = '\u001b[?25h'
const RESIZE = 'resize'

export function createTerminalProxy(
	realOut: NodeJS.WriteStream,
	realIn: NodeJS.ReadStream,
): TerminalProxy {
	let zoomed: ZoomedOutput | null = null
	let keyHandler: ((chunk: string) => string | null) | null = null
	let trigger: { key: string; run: () => void } | null = null
	let realResize: (() => void) | null = null
	let cursorHidden = false
	const resizes = new EventEmitter()
	let subscribed = false

	const noteCursor = (chunk: unknown): void => {
		if (typeof chunk !== 'string' || !chunk.includes('\u001b[?25')) return
		const hide = chunk.lastIndexOf(HIDE)
		const show = chunk.lastIndexOf(SHOW)
		if (hide !== show) cursorHidden = hide > show
	}

	const subscribe = (): void => {
		if (subscribed) return
		subscribed = true
		realOut.on(RESIZE, () => {
			if (zoomed) realResize?.()
			else resizes.emit(RESIZE)
		})
	}

	const out = new Proxy(realOut, {
		get(target, prop) {
			if (prop === 'write') {
				return (chunk: unknown, ...rest: unknown[]): boolean => {
					noteCursor(chunk)
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
						const chunk = Reflect.apply(target.read, target, args) as unknown
						if (typeof chunk !== 'string') return chunk
						if (zoomed !== null && keyHandler !== null) {
							const kept = keyHandler(chunk)
							if (kept !== null) return kept
							continue
						}
						if (trigger !== null && chunk.includes(trigger.key)) {
							const rest = chunk.split(trigger.key).join('')
							trigger.run()
							if (rest.length === 0) continue
							return rest
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
			realResize = listener
			subscribe()
		},
		setTrigger(key, run) {
			trigger = { key, run }
		},
	}
}
