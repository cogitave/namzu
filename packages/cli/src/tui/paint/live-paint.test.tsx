import { EventEmitter } from 'node:events'

import { Terminal } from '@xterm/headless'
import { Box, Static, Text, render } from 'ink'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import {
	FRAME_MS,
	RESIZE_HOLD_MS,
	RESIZE_SETTLE_MS,
	createLivePaint,
	reflowedRows,
	startOnFreshLine,
} from './live-paint.js'

const ESC = '\u001b'
const BSU = `${ESC}[?2026h`
const ESU = `${ESC}[?2026l`
/** A write cut after each line break and each escape sequence. */
const PIECES = new RegExp(`[^\\n${ESC}]*(?:\\n|${ESC}\\[[0-9;?]*[A-Za-z])|[^\\n${ESC}]+`, 'g')

/** A clock the test moves, and the timers on it. */
function fakeClock() {
	let now = 0
	let nextId = 1
	const due = new Map<number, { at: number; run: () => void }>()
	return {
		now: () => now,
		set(run: () => void, ms: number) {
			const id = nextId++
			due.set(id, { at: now + ms, run })
			return id
		},
		clear(handle: unknown) {
			due.delete(handle as number)
		},
		/** Moves the clock, running every timer that comes due on the way, in order. */
		advance(ms: number) {
			const end = now + ms
			for (;;) {
				let next: [number, { at: number; run: () => void }] | undefined
				for (const entry of due)
					if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry
				if (!next) break
				due.delete(next[0])
				now = Math.max(now, next[1].at)
				next[1].run()
			}
			now = end
		},
	}
}

/** A terminal the writes go to: an emulator, and the bytes it was sent. */
class Tty extends EventEmitter {
	isTTY = true
	readonly term: Terminal
	readonly writes: string[] = []
	constructor(
		public columns: number,
		public rows: number,
		convertEol = false,
	) {
		super()
		this.term = new Terminal({
			cols: columns,
			rows,
			scrollback: 500,
			convertEol,
			allowProposedApi: true,
		})
	}
	write = (chunk: string, cb?: () => void): boolean => {
		if (chunk !== '') {
			this.writes.push(chunk)
			this.term.write(chunk)
		}
		if (cb) this.term.write('', cb)
		return true
	}
	resize(columns: number, rows: number): void {
		this.columns = columns
		this.rows = rows
		this.term.resize(columns, rows)
		this.emit('resize')
	}
	async drain(): Promise<void> {
		await new Promise<void>((resolve) => this.term.write('', resolve))
	}
	/** Every row held, scrollback first, trailing blanks trimmed. */
	async screen(): Promise<string[]> {
		await this.drain()
		const buffer = this.term.buffer.active
		const rows: string[] = []
		for (let i = 0; i < buffer.baseY + this.rows; i++)
			rows.push(buffer.getLine(i)?.translateToString(true) ?? '')
		while (rows.at(-1) === '') rows.pop()
		return rows
	}
	get sent(): string {
		return this.writes.join('')
	}
}

const erase = (rows: number): string => {
	if (rows === 0) return ''
	let out = ''
	for (let i = 0; i < rows; i++) out += `${ESC}[2K${i < rows - 1 ? `${ESC}[1A` : ''}`
	return `${out}${ESC}[G`
}

/** What Ink writes for one frame, in its plain mode. */
function inkFrame(
	out: NodeJS.WriteStream,
	frame: string,
	previousRows: number,
	statics = '',
): void {
	out.write(BSU)
	if (statics === '') out.write(erase(previousRows) + frame)
	else {
		out.write(erase(previousRows))
		out.write(statics)
		out.write(frame)
	}
	out.write(ESU)
}

function rig(columns = 40, rows = 12) {
	const tty = new Tty(columns, rows)
	const clock = fakeClock()
	const paint = createLivePaint(tty as unknown as NodeJS.WriteStream, {
		timers: { now: clock.now, set: clock.set, clear: clock.clear },
		process: null,
	})
	return { tty, clock, paint, out: paint.stream }
}

describe('a frame writes only what changed', () => {
	it('one changed row costs that row, with no erase of the region', async () => {
		const { tty, clock, out } = rig()
		inkFrame(out, 'one\ntwo\nthree\nfour\n', 0)
		await tty.drain()
		const before = tty.sent.length
		inkFrame(out, 'one\ntwo\nTHREE\nfour\n', 5)
		clock.advance(FRAME_MS)
		const written = tty.sent.slice(before)
		expect(written).toContain('THREE')
		expect(written).not.toContain(`${ESC}[2K`)
		expect(written).not.toContain(`${ESC}[J`)
		expect(written.length).toBeLessThan(60)
		expect(await tty.screen()).toEqual(['one', 'two', 'THREE', 'four'])
	})

	it('a frame equal to the one on screen writes nothing at all', async () => {
		const { tty, clock, out } = rig()
		inkFrame(out, 'one\ntwo\n', 0)
		const count = tty.writes.length
		inkFrame(out, 'one\ntwo\n', 3)
		clock.advance(FRAME_MS * 3)
		expect(tty.writes.length).toBe(count)
	})

	it('a letter whose colour moves costs a cursor move and that letter', async () => {
		const { tty, clock, out } = rig(60)
		const label = (edge: number) =>
			`${[...'Working'].map((c, i) => `${ESC}[${i < edge ? 32 : i === edge ? 97 : 90}m${c}${ESC}[39m`).join('')} (3s)\n`
		inkFrame(out, label(2), 0)
		const before = tty.sent.length
		inkFrame(out, label(3), 2)
		clock.advance(FRAME_MS)
		const written = tty.sent.slice(before)
		expect(written.length).toBeLessThan(60)
		expect(written).not.toContain(`${ESC}[2K`)
		expect(await tty.screen()).toEqual(['Working (3s)'])
	})

	it('shrinking and growing the region leaves exactly the new rows', async () => {
		const { tty, clock, out } = rig()
		inkFrame(out, 'a\nb\nc\nd\n', 0)
		inkFrame(out, 'a\nb\n', 5)
		clock.advance(FRAME_MS)
		expect(await tty.screen()).toEqual(['a', 'b'])
		inkFrame(out, 'a\nb\nc\n', 3)
		clock.advance(FRAME_MS)
		expect(await tty.screen()).toEqual(['a', 'b', 'c'])
		inkFrame(out, 'a\nB\nc\nd\ne\n', 4)
		clock.advance(FRAME_MS)
		expect(await tty.screen()).toEqual(['a', 'B', 'c', 'd', 'e'])
	})

	it('rows printed once go above the region, and the region is drawn under them', async () => {
		const { tty, clock, out } = rig()
		inkFrame(out, 'live one\nlive two\n', 0)
		inkFrame(out, 'live two\nlive three\n', 3, 'printed\n')
		clock.advance(FRAME_MS)
		expect(await tty.screen()).toEqual(['printed', 'live two', 'live three'])
	})
})

describe('a paint that carries printed rows never shows a blank bottom', () => {
	/** Every state a second emulator passes through while it parses `data`, cut after each line break and each escape. */
	async function steps(earlier: string, data: string): Promise<string[][]> {
		const replay = new Tty(40, 12)
		replay.write(earlier)
		const pieces = data.match(PIECES) ?? []
		const seen: string[][] = []
		for (const piece of pieces) {
			replay.write(piece)
			seen.push(await replay.screen())
		}
		return seen
	}

	it('the status row is always there and no row is blank while the new rows are written over the old', async () => {
		const { tty, clock, out } = rig(40, 12)
		const frame = (tag: string) => `${'-'.repeat(10)}\ncomposer ${tag}\nstatus ${tag}\n`
		inkFrame(out, frame('a'), 0)
		await tty.drain()
		const before = tty.writes.length
		inkFrame(out, frame('b'), 4, 'printed one\nprinted two\n')
		clock.advance(FRAME_MS)
		const earlier = tty.writes.slice(0, before).join('')
		const data = tty.writes.slice(before).join('')
		for (const screen of await steps(earlier, data)) {
			// Old rows give way to new ones in place: a composer row and a status row are always there, and no row is left blank.
			expect(
				screen.some((r) => r.startsWith('composer')),
				screen.join('|'),
			).toBe(true)
			expect(
				screen.some((r) => r.startsWith('status')),
				screen.join('|'),
			).toBe(true)
			expect(screen.includes(''), screen.join('|')).toBe(false)
		}
		expect(await tty.screen()).toEqual([
			'printed one',
			'printed two',
			'----------',
			'composer b',
			'status b',
		])
	})
})

describe('a paint that carries printed rows into a region that shrinks', () => {
	it('keeps a composer and a status row at every step and ends with exactly the new rows', async () => {
		const { tty, clock, out } = rig(40, 12)
		inkFrame(out, 'tip\nmore\n----------\ncomposer a\nstatus a\n', 0)
		await tty.drain()
		const before = tty.writes.length
		inkFrame(out, 'composer b\nstatus b\n', 6, 'printed\n')
		clock.advance(FRAME_MS)
		const replay = new Tty(40, 12)
		replay.write(tty.writes.slice(0, before).join(''))
		const pieces = tty.writes.slice(before).join('').match(PIECES) ?? []
		for (const piece of pieces) {
			replay.write(piece)
			const screen = await replay.screen()
			expect(
				screen.some((r) => r.startsWith('composer')),
				screen.join('|'),
			).toBe(true)
			expect(
				screen.some((r) => r.startsWith('status')),
				screen.join('|'),
			).toBe(true)
		}
		expect(await tty.screen()).toEqual(['printed', 'composer b', 'status b'])
	})
})

describe('the frame budget', () => {
	it('a hundred updates in a second paint at most twelve frames, and the last state is never lost', async () => {
		const { tty, clock, out } = rig()
		let previous = 0
		let paints = 0
		const seen = () => tty.writes.filter((w) => w.startsWith(BSU)).length
		for (let i = 0; i < 100; i++) {
			const frame = `state ${i}\nfooter\n`
			inkFrame(out, frame, previous)
			previous = 3
			clock.advance(10)
			paints = seen()
		}
		expect(paints).toBeLessThanOrEqual(12)
		expect(paints).toBeGreaterThanOrEqual(8)
		clock.advance(FRAME_MS)
		expect(await tty.screen()).toEqual(['state 99', 'footer'])
	})

	it('rows to print once survive the frames folded around them, in order', async () => {
		const { tty, clock, out } = rig()
		inkFrame(out, 'live\n', 0)
		inkFrame(out, 'live 2\n', 2, 'first\n')
		inkFrame(out, 'live 3\n', 2, 'second\n')
		inkFrame(out, 'live 4\n', 2)
		clock.advance(FRAME_MS * 2)
		expect(await tty.screen()).toEqual(['first', 'second', 'live 4'])
	})

	it('writes nothing while nothing changes, however long it waits', async () => {
		const { tty, clock, out } = rig()
		inkFrame(out, 'live\n', 0)
		clock.advance(1)
		const count = tty.writes.length
		clock.advance(60_000)
		expect(tty.writes.length).toBe(count)
	})
})

describe('launch and exit', () => {
	it('never clears the screen or the scrollback, and shows the cursor on the way out', async () => {
		const tty = new Tty(40, 8)
		for (let i = 1; i <= 20; i++) tty.write(`history ${i}\r\n`)
		const clock = fakeClock()
		const paint = createLivePaint(tty as unknown as NodeJS.WriteStream, {
			timers: { now: clock.now, set: clock.set, clear: clock.clear },
			process: null,
		})
		const out = paint.stream
		out.write(`${ESC}[?25l`)
		inkFrame(out, 'banner\nlive\n', 0)
		inkFrame(out, 'banner\nlive again\n', 3)
		clock.advance(200)
		paint.dispose()
		expect(tty.sent).not.toContain(`${ESC}[2J`)
		expect(tty.sent).not.toContain(`${ESC}[3J`)
		expect(tty.sent).not.toContain(`${ESC}[H`)
		expect(tty.sent.endsWith(`${ESC}[?25h`)).toBe(true)
		const screen = await tty.screen()
		expect(screen.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, i) => `history ${i + 1}`))
		expect(screen.slice(20)).toEqual(['banner', 'live again'])
		// The cursor is at the start of the line under the last frame.
		expect(tty.term.buffer.active.cursorX).toBe(0)
		expect(tty.term.buffer.active.baseY + tty.term.buffer.active.cursorY).toBe(22)
	})

	it('a process that ends without unmounting paints the last frame and shows the cursor', async () => {
		const tty = new Tty(40, 8)
		const clock = fakeClock()
		const proc = new EventEmitter()
		const paint = createLivePaint(tty as unknown as NodeJS.WriteStream, {
			timers: { now: clock.now, set: clock.set, clear: clock.clear },
			process: proc as unknown as NodeJS.Process,
		})
		paint.stream.write(`${ESC}[?25l`)
		inkFrame(paint.stream, 'first\n', 0)
		inkFrame(paint.stream, 'second\n', 2)
		proc.emit('exit')
		expect(tty.sent.endsWith(`${ESC}[?25h`)).toBe(true)
		expect((await tty.screen()).at(-1)).toBe('second')
	})

	it('continued after a stop, it draws a fresh frame on a new line instead of over the shell', async () => {
		const tty = new Tty(40, 10)
		const clock = fakeClock()
		const proc = new EventEmitter()
		const paint = createLivePaint(tty as unknown as NodeJS.WriteStream, {
			timers: { now: clock.now, set: clock.set, clear: clock.clear },
			process: proc as unknown as NodeJS.Process,
		})
		inkFrame(paint.stream, 'frame\n', 0)
		tty.write('[1]+ Stopped\r\n$ fg\r\n')
		proc.emit('SIGCONT')
		const screen = await tty.screen()
		expect(screen).toEqual(['frame', '[1]+ Stopped', '$ fg', '', 'frame'])
	})
})

describe('starting on a fresh line', () => {
	it('leaves a cursor at the start of a line where it is, and ends a half-written line otherwise', async () => {
		const clean = new Tty(20, 6)
		clean.write('$ namzu\r\n')
		clean.write(startOnFreshLine(20))
		await clean.drain()
		expect(clean.term.buffer.active.cursorX).toBe(0)
		expect(clean.term.buffer.active.cursorY).toBe(1)
		expect(await clean.screen()).toEqual(['$ namzu'])

		const half = new Tty(20, 6)
		half.write('left mid-line')
		half.write(startOnFreshLine(20))
		await half.drain()
		expect(half.term.buffer.active.cursorX).toBe(0)
		expect(half.term.buffer.active.cursorY).toBe(1)
		expect((await half.screen())[0]?.startsWith('left mid-line%')).toBe(true)
		expect(startOnFreshLine(20)).not.toContain(`${ESC}[2J`)
		expect(startOnFreshLine(20)).not.toContain(`${ESC}[3J`)
	})
})

describe('a resize', () => {
	it('a burst gives one redraw: the scrollback stays, only the region is drawn again, once', async () => {
		const { tty, clock, paint, out } = rig(40, 12)
		for (let i = 1; i <= 30; i++) tty.write(`history ${i}\r\n`)
		const rule40 = '-'.repeat(40)
		const frameAt = (width: number) => `${'-'.repeat(width)}\nlive row\n${'-'.repeat(width)}\n`
		inkFrame(out, frameAt(40), 0)
		expect(rule40.length).toBe(40)
		let told = 0
		out.on('resize', () => {
			told += 1
			// What Ink does: lays out again and writes the frame for the new width.
			inkFrame(out, frameAt(tty.columns), 4)
		})
		const before = tty.writes.length
		tty.resize(30, 12)
		clock.advance(40)
		tty.resize(24, 12)
		clock.advance(40)
		tty.resize(20, 12)
		clock.advance(RESIZE_SETTLE_MS - 1)
		expect(told).toBe(0)
		expect(tty.writes.length).toBe(before)
		clock.advance(1)
		expect(told).toBe(1)
		clock.advance(RESIZE_HOLD_MS)
		const sent = tty.writes.slice(before).join('')
		expect(sent).not.toContain(`${ESC}[2J`)
		expect(sent).not.toContain(`${ESC}[3J`)
		expect(sent.split(BSU).length - 1).toBe(1)
		const screen = await tty.screen()
		const live = screen.slice(-3)
		expect(live).toEqual(['-'.repeat(20), 'live row', '-'.repeat(20)])
		// Everything above the region is what was there: the history, reflowed by the terminal, and no leftover fragment.
		expect(screen.slice(0, 30)).toEqual(Array.from({ length: 30 }, (_, i) => `history ${i + 1}`))
		expect(screen).toHaveLength(33)
		paint.dispose()
	})

	it('a frame waiting its turn is not painted while the size is still moving', async () => {
		const { tty, clock, out } = rig(40, 12)
		inkFrame(out, 'one\n', 0)
		inkFrame(out, 'two\n', 2)
		const before = tty.writes.length
		tty.resize(30, 12)
		clock.advance(FRAME_MS * 1.5)
		expect(tty.writes.length).toBe(before)
		out.on('resize', () => inkFrame(out, 'two\n', 2))
		clock.advance(RESIZE_SETTLE_MS + RESIZE_HOLD_MS)
		expect((await tty.screen()).at(-1)).toBe('two')
	})

	it('counts the rows a reflowing terminal makes of the region', () => {
		expect(reflowedRows(['-'.repeat(40), 'live', ''], 20)).toBe(4)
		expect(reflowedRows(['-'.repeat(40), 'live'], 80)).toBe(2)
		expect(reflowedRows([`${ESC}[32m${'x'.repeat(30)}${ESC}[39m`], 10)).toBe(3)
	})

	it('no frame at the old width is written between the resize and the new frame', async () => {
		const { tty, clock, out } = rig(40, 12)
		inkFrame(out, `${'-'.repeat(40)}\nlive\n`, 0)
		out.on('resize', () => {
			// Ink's first frame after the event still carries the old width; the one drawn at the new width follows.
			inkFrame(out, `${'-'.repeat(40)}\nlive\n`, 3)
			inkFrame(out, `${'-'.repeat(20)}\nlive\n`, 3)
		})
		const before = tty.writes.length
		tty.resize(20, 12)
		clock.advance(RESIZE_SETTLE_MS + RESIZE_HOLD_MS)
		const sent = tty.writes.slice(before).join('')
		expect(sent).not.toContain('-'.repeat(21))
		expect((await tty.screen()).slice(-2)).toEqual(['-'.repeat(20), 'live'])
	})
})

describe('a frame as tall as the terminal', () => {
	it('comes without its newline and is painted like any other', async () => {
		const { tty, clock, out } = rig(40, 12)
		inkFrame(out, 'one\ntwo\n', 0)
		inkFrame(out, 'one\nTWO', 3)
		clock.advance(FRAME_MS)
		expect(await tty.screen()).toEqual(['one', 'TWO'])
	})
})

describe('a frame Ink would clear the terminal for', () => {
	it('is painted as a frame: nothing is cleared and the rows printed before stay once', async () => {
		const { tty, clock, out } = rig(40, 12)
		inkFrame(out, 'live one\nlive two\n', 0, '')
		inkFrame(out, 'live two\n', 3, 'row 1\n')
		inkFrame(out, 'live two\n', 2, 'row 2\n')
		clock.advance(FRAME_MS)
		const before = tty.sent.length
		// What Ink writes when the frame it drew for the old size is taller than the new terminal: it clears,
		// prints everything it ever printed, then the frame without its newline.
		out.write(BSU)
		out.write(`${ESC}[2J${ESC}[3J${ESC}[Hrow 1\nrow 2\nlive a\nlive b\nlive c`)
		out.write(ESU)
		clock.advance(FRAME_MS)
		const sent = tty.sent.slice(before)
		expect(sent).not.toContain(`${ESC}[2J`)
		expect(sent).not.toContain(`${ESC}[3J`)
		expect(await tty.screen()).toEqual(['row 1', 'row 2', 'live a', 'live b', 'live c'])
	})
})

describe('through Ink', () => {
	const mounted: { unmount: () => void }[] = []
	afterEach(() => {
		for (const m of mounted.splice(0)) m.unmount()
	})

	function app(step: number): ReactElement {
		const done = Array.from({ length: Math.floor(step / 2) }, (_, i) => `settled row ${i + 1}`)
		return (
			<Box flexDirection="column">
				<Static items={done}>{(row) => <Text key={row}>{row}</Text>}</Static>
				<Text>{`live counter ${step}`}</Text>
				<Box height={step % 3}>
					<Text>tall</Text>
				</Box>
				<Text>{'-'.repeat(20)}</Text>
			</Box>
		)
	}

	async function run(painted: boolean): Promise<string[][]> {
		const tty = new Tty(40, 14, true)
		const clock = fakeClock()
		const paint = painted
			? createLivePaint(tty as unknown as NodeJS.WriteStream, {
					timers: { now: clock.now, set: clock.set, clear: clock.clear },
					process: null,
				})
			: null
		const stdin = Object.assign(new EventEmitter(), {
			isTTY: true,
			setEncoding() {},
			setRawMode() {},
			ref() {},
			unref() {},
			resume() {},
			pause() {},
			read: () => null,
		})
		const instance = render(app(0), {
			stdout: (paint?.stream ?? tty) as unknown as NodeJS.WriteStream,
			stdin: stdin as unknown as NodeJS.ReadStream,
			interactive: true,
			patchConsole: false,
			exitOnCtrlC: false,
		})
		mounted.push(instance)
		const shots: string[][] = []
		for (let step = 0; step <= 9; step++) {
			if (step > 0) instance.rerender(app(step))
			await instance.waitUntilRenderFlush()
			clock.advance(FRAME_MS * 2)
			shots.push(await tty.screen())
		}
		return shots
	}

	it('draws the same screens as Ink does by itself, through growth, shrinking and printed rows', async () => {
		const plain = await run(false)
		const painted = await run(true)
		expect(painted).toEqual(plain)
		expect(painted.at(-1)).toContain('settled row 4')
	})
})
