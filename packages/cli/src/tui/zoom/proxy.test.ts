import { EventEmitter } from 'node:events'

import { Box, Static, Text, render } from 'ink'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

import { createTerminalProxy } from './proxy.js'

class FakeStdin extends EventEmitter {
	isTTY = true
	private queue: string[] = []
	reads = 0
	read(): string | null {
		this.reads += 1
		return this.queue.shift() ?? null
	}
	setEncoding(): void {}
	setRawMode(): void {}
	ref(): void {}
	unref(): void {}
	resume(): void {}
	pause(): void {}
	press(input: string): void {
		this.queue.push(input)
		this.emit('readable')
	}
}

class FakeStdout extends EventEmitter {
	isTTY = true
	columns = 100
	rows = 30
	writes: unknown[][] = []
	write(...args: unknown[]): boolean {
		this.writes.push(args)
		return true
	}
	getWindowSize(): [number, number] {
		return [this.columns, this.rows]
	}
}

const asStdout = (s: FakeStdout) => s as unknown as NodeJS.WriteStream
const asStdin = (s: FakeStdin) => s as unknown as NodeJS.ReadStream

function app(lines: readonly string[], live: string) {
	return createElement(
		Box,
		{ flexDirection: 'column' },
		createElement(Static as never, { items: [...lines] }, ((line: string) =>
			createElement(Text, { key: line }, line)) as never),
		createElement(Text, null, live),
	)
}

/** Drives one Ink instance through the same frames and resizes; returns every write it made. */
async function drive(stdout: FakeStdout, mounted: { stdout: NodeJS.WriteStream }) {
	const instance = render(app([], 'start'), {
		stdout: mounted.stdout,
		stdin: asStdin(new FakeStdin()),
		stderr: process.stderr,
		interactive: true,
		patchConsole: false,
		exitOnCtrlC: false,
	})
	await instance.waitUntilRenderFlush()
	instance.rerender(app(['one'], 'live 1'))
	await instance.waitUntilRenderFlush()
	instance.rerender(app(['one', 'two', 'three'], 'live 2'))
	await instance.waitUntilRenderFlush()
	stdout.columns = 60
	stdout.emit('resize')
	await instance.waitUntilRenderFlush()
	instance.rerender(app(['one', 'two', 'three', 'four'], 'live 3'))
	await instance.waitUntilRenderFlush()
	instance.unmount()
	return stdout.writes
}

describe('direct mode', () => {
	it('gives Ink byte-identical output to a raw stream, across frames, static rows, a resize and unmount', async () => {
		const raw = new FakeStdout()
		const viaProxy = new FakeStdout()
		const proxy = createTerminalProxy(asStdout(viaProxy), asStdin(new FakeStdin()))
		const expected = await drive(raw, { stdout: asStdout(raw) })
		const actual = await drive(viaProxy, { stdout: proxy.stdout })
		expect(expected.length).toBeGreaterThan(5)
		expect(actual).toEqual(expected)
	})

	it('reports the real size live and passes arguments, callbacks and the return value through', () => {
		const real = new FakeStdout()
		const proxy = createTerminalProxy(asStdout(real), asStdin(new FakeStdin()))
		expect(proxy.mode).toBe('direct')
		expect([proxy.stdout.columns, proxy.stdout.rows]).toEqual([100, 30])
		real.columns = 90
		expect(proxy.stdout.columns).toBe(90)
		expect(proxy.stdout.isTTY).toBe(true)
		const done = () => undefined
		expect(proxy.stdout.write('x', 'utf8', done)).toBe(true)
		expect(real.writes).toEqual([['x', 'utf8', done]])
	})

	it('delivers the real stream’s resize to listeners, and removes them again', () => {
		const real = new FakeStdout()
		const proxy = createTerminalProxy(asStdout(real), asStdin(new FakeStdin()))
		let seen = 0
		const listener = () => {
			seen += 1
		}
		proxy.stdout.on('resize', listener)
		real.emit('resize')
		expect(seen).toBe(1)
		proxy.stdout.off('resize', listener)
		real.emit('resize')
		expect(seen).toBe(1)
	})

	it('reads input unchanged, and takes the trigger key out of what Ink reads', () => {
		const real = new FakeStdin()
		const proxy = createTerminalProxy(asStdout(new FakeStdout()), asStdin(real))
		real.press('abc')
		expect(proxy.stdin.read()).toBe('abc')
		expect(proxy.stdin.read()).toBeNull()

		let triggered = 0
		proxy.setTrigger('\u001d', () => {
			triggered += 1
		})
		real.press('a\u001db')
		expect(proxy.stdin.read()).toBe('ab')
		real.press('\u001d')
		// A chunk that was only the trigger is read past, to the null that re-arms 'readable'.
		expect(proxy.stdin.read()).toBeNull()
		expect(triggered).toBe(2)
	})

	it('remembers whether the last cursor sequence hid the cursor', () => {
		const proxy = createTerminalProxy(asStdout(new FakeStdout()), asStdin(new FakeStdin()))
		expect(proxy.cursorHidden).toBe(false)
		proxy.stdout.write('\u001b[?25l')
		expect(proxy.cursorHidden).toBe(true)
		proxy.stdout.write('x\u001b[?25l\u001b[?25hy')
		expect(proxy.cursorHidden).toBe(false)
	})
})

describe('zoomed mode', () => {
	it('sends writes to the sink, reports its size, and tells listeners on every switch', () => {
		const real = new FakeStdout()
		const proxy = createTerminalProxy(asStdout(real), asStdin(new FakeStdin()))
		const sunk: string[] = []
		const sink = {
			columns: 70,
			rows: 20,
			write: (chunk: string) => {
				sunk.push(chunk)
			},
		}
		let resizes = 0
		proxy.stdout.on('resize', () => {
			resizes += 1
		})
		proxy.enterZoomed(sink, () => null)
		expect(resizes).toBe(1)
		expect(proxy.mode).toBe('zoomed')
		expect([proxy.stdout.columns, proxy.stdout.rows]).toEqual([70, 20])
		expect(proxy.stdout.getWindowSize()).toEqual([70, 20])
		let called = false
		proxy.stdout.write('inside\n', () => {
			called = true
		})
		expect(sunk).toEqual(['inside\n'])
		expect(called).toBe(true)
		expect(real.writes).toEqual([])

		proxy.resizeZoomed(50, 10)
		expect(resizes).toBe(2)
		expect([proxy.stdout.columns, proxy.stdout.rows]).toEqual([50, 10])

		proxy.leaveZoomed()
		expect(resizes).toBe(3)
		expect([proxy.stdout.columns, proxy.stdout.rows]).toEqual([100, 30])
		proxy.stdout.write('after')
		expect(real.writes).toEqual([['after']])
	})

	it('keeps a real resize away from Ink while zoomed and hands it to the zoom code', () => {
		const real = new FakeStdout()
		const proxy = createTerminalProxy(asStdout(real), asStdin(new FakeStdin()))
		let inkSaw = 0
		let zoomSaw = 0
		proxy.stdout.on('resize', () => {
			inkSaw += 1
		})
		proxy.onRealResize(() => {
			zoomSaw += 1
		})
		proxy.enterZoomed({ columns: 10, rows: 5, write: () => undefined }, () => null)
		inkSaw = 0
		real.emit('resize')
		expect([inkSaw, zoomSaw]).toEqual([0, 1])
	})

	it('lets the key handler decide what Ink reads, and reads on past a consumed key', () => {
		const real = new FakeStdin()
		const proxy = createTerminalProxy(asStdout(new FakeStdout()), asStdin(real))
		const seen: string[] = []
		proxy.enterZoomed({ columns: 10, rows: 5, write: () => undefined }, (chunk) => {
			seen.push(chunk)
			return chunk === 'x' ? null : chunk
		})
		real.press('x')
		expect(proxy.stdin.read()).toBeNull()
		real.press('y')
		expect(proxy.stdin.read()).toBe('y')
		expect(seen).toEqual(['x', 'y'])
	})
})
