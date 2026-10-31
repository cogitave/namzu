import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import { createTerminalProxy } from './proxy.js'
import { createZoomController, layoutFor } from './zoom.js'

class FakeStdin extends EventEmitter {
	isTTY = true
	private queue: string[] = []
	read(): string | null {
		return this.queue.shift() ?? null
	}
	setEncoding(): void {}
	press(input: string): void {
		this.queue.push(input)
		this.emit('readable')
	}
}

class FakeStdout extends EventEmitter {
	isTTY = true
	columns = 100
	rows = 30
	writes: string[] = []
	write(text: string): boolean {
		this.writes.push(text)
		return true
	}
	getWindowSize(): [number, number] {
		return [this.columns, this.rows]
	}
	text(): string {
		return this.writes.join('')
	}
}

function setup() {
	const real = new FakeStdout()
	const input = new FakeStdin()
	const proxy = createTerminalProxy(
		real as unknown as NodeJS.WriteStream,
		input as unknown as NodeJS.ReadStream,
	)
	const zoom = createZoomController(proxy, real as unknown as NodeJS.WriteStream)
	return { real, input, proxy, zoom }
}

describe('layout', () => {
	it('leaves a sidebar, a divider and the pane on one row band, and refuses a tiny screen', () => {
		const l = layoutFor(100, 30)
		expect(l).not.toBeNull()
		expect(l?.sidebar).toEqual({ x: 0, y: 0, width: 24, height: 29 })
		expect(l?.pane).toEqual({ x: 25, y: 0, width: 75, height: 29 })
		expect(layoutFor(40, 30)).toBeNull()
		expect(layoutFor(100, 5)).toBeNull()
	})
})

describe('zooming', () => {
	it('does nothing on a screen that is too small', () => {
		const { real, zoom } = setup()
		real.columns = 30
		expect(zoom.zoomOut()).toBe(false)
		expect(real.writes).toEqual([])
	})

	it('shows what Ink writes in the pane, then hands the screen back and tells Ink the real size', async () => {
		const { real, proxy, zoom } = setup()
		const sizes: number[] = []
		proxy.stdout.on('resize', () => {
			sizes.push(proxy.stdout.columns)
		})
		expect(zoom.zoomOut()).toBe(true)
		expect(real.text().startsWith('\u001b[?1049h')).toBe(true)
		expect(sizes).toEqual([75])

		const before = real.writes.length
		proxy.stdout.write('hello from the pane\nsecond row')
		await zoom.drawn()
		const drawn = real.writes.slice(before).join('')
		expect(drawn).toContain('hello')
		expect(drawn).not.toContain('\u001b[?1049l')

		zoom.zoomIn()
		expect(real.text()).toContain('\u001b[?1049l')
		// The cursor is put back to what Ink last asked for (shown: it never hid it).
		expect(real.writes.at(-1)).toBe('\u001b[?25h')
		expect(sizes).toEqual([75, 100])
		expect(zoom.zoomed).toBe(false)
		// Direct again.
		proxy.stdout.write('direct')
		expect(real.writes.at(-1)).toBe('direct')
	})

	it('restores a hidden cursor on the way back', () => {
		const { real, proxy, zoom } = setup()
		zoom.zoomOut()
		proxy.stdout.write('\u001b[?25l')
		zoom.zoomIn()
		expect(real.writes.at(-1)).toBe('\u001b[?25l')
	})

	it('routes keys: right arrow zooms in, enter starts typing, esc stops, other keys go to Ink only when typing', () => {
		const { input, proxy, zoom } = setup()
		zoom.zoomOut()
		input.press('q')
		expect(proxy.stdin.read()).toBeNull()
		input.press('\r')
		expect(proxy.stdin.read()).toBeNull()
		expect(zoom.focus).toBe('pane')
		input.press('hi')
		expect(proxy.stdin.read()).toBe('hi')
		input.press('\u001b')
		expect(proxy.stdin.read()).toBeNull()
		expect(zoom.focus).toBe('sidebar')
		input.press('\u001b[C')
		expect(proxy.stdin.read()).toBeNull()
		expect(zoom.zoomed).toBe(false)
	})

	it('hands Ctrl+C to Ink from the sidebar and takes an arrow glued to another key', () => {
		const a = setup()
		a.zoom.zoomOut()
		a.input.press('\u0003')
		expect(a.proxy.stdin.read()).toBe('\u0003')
		expect(a.zoom.zoomed).toBe(true)
		const b = setup()
		b.zoom.zoomOut()
		b.input.press('\u001b\u001b[C')
		expect(b.proxy.stdin.read()).toBeNull()
		expect(b.zoom.zoomed).toBe(false)
	})

	it('follows a real resize while zoomed: the pane changes size and Ink hears of it', () => {
		const { real, proxy, zoom } = setup()
		zoom.zoomOut()
		const sizes: number[] = []
		proxy.stdout.on('resize', () => {
			sizes.push(proxy.stdout.columns)
		})
		real.columns = 140
		real.emit('resize')
		expect(sizes).toEqual([115])
		zoom.zoomIn()
		expect(sizes).toEqual([115, 140])
	})
})
