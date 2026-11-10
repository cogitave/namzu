import { describe, expect, it } from 'vitest'

import { createMouseFilter, installMouseWheel } from './mouse-wheel.js'

const up = '\u001b[<64;10;5M'
const down = '\u001b[<65;10;5M'

describe('the pointer filter', () => {
	it('turns wheel reports into directions and removes them from the text', () => {
		const out = createMouseFilter().feed(`a${up}b${down}${down}c`)
		expect(out.text).toBe('abc')
		expect(out.wheel).toEqual(['up', 'down', 'down'])
	})

	it('reads a wheel notch with a modifier held', () => {
		expect(createMouseFilter().feed('\u001b[<68;1;1M').wheel).toEqual(['up'])
	})

	it('swallows presses, drags and releases without scrolling, and reports the left button', () => {
		const out = createMouseFilter().feed('\u001b[<0;3;4M\u001b[<32;4;4M\u001b[<0;4;4m')
		expect(out.text).toBe('')
		expect(out.wheel).toEqual([])
		expect(out.pointer).toEqual([
			{ kind: 'press', x: 3, y: 4 },
			{ kind: 'drag', x: 4, y: 4 },
			{ kind: 'release', x: 4, y: 4 },
		])
	})

	it('swallows the other buttons without reporting them', () => {
		const out = createMouseFilter().feed(
			'\u001b[<2;3;4M\u001b[<1;3;4M\u001b[<35;3;4M\u001b[<2;3;4m',
		)
		expect(out).toEqual({ text: '', wheel: [], pointer: [] })
	})

	it('leaves everything else byte for byte, a lone Escape included', () => {
		const filter = createMouseFilter()
		for (const text of ['hello', '\u001b', '\u001b[A', '\u001b[5~', '[<64;1;1M']) {
			expect(filter.feed(text)).toEqual({ text, wheel: [], pointer: [] })
		}
	})

	it('waits for the rest of a report that was split across two reads', () => {
		const filter = createMouseFilter()
		expect(filter.feed('x\u001b[<6')).toEqual({ text: 'x', wheel: [], pointer: [] })
		expect(filter.feed('4;10;5Mz')).toEqual({ text: 'z', wheel: ['up'], pointer: [] })
	})
})

describe('installing the pointer', () => {
	function streams(isTTY: boolean) {
		const written: string[] = []
		const chunks: unknown[] = [`${up}typed`]
		const stdin = { isTTY, read: () => chunks.shift() ?? null }
		const stdout = { isTTY, write: (text: string) => written.push(text) }
		return { stdin, stdout, written }
	}

	it('asks for wheel reports, filters the stream and gives the pointer back', () => {
		const { stdin, stdout, written } = streams(true)
		const seen: string[] = []
		const stop = installMouseWheel(stdin, stdout, (direction) => seen.push(direction))
		expect(written.join('')).toContain('\u001b[?1000h')
		expect(stdin.read()).toBe('typed')
		expect(seen).toEqual(['up'])
		stop()
		expect(written.join('')).toContain('\u001b[?1000l')
		stop()
		expect(written.filter((w) => w.includes('?1000l'))).toHaveLength(1)
	})

	it('asks for drags and hands the left button over when a pointer listener is given', () => {
		const { stdin, stdout, written } = streams(true)
		const chunks: unknown[] = ['\u001b[<0;5;6Mhi\u001b[<0;5;6m']
		stdin.read = () => chunks.shift() ?? null
		const seen: string[] = []
		const stop = installMouseWheel(
			stdin,
			stdout,
			() => undefined,
			(report) => seen.push(`${report.kind}@${report.x},${report.y}`),
		)
		expect(written.join('')).toContain('\u001b[?1002h')
		expect(stdin.read()).toBe('hi')
		expect(seen).toEqual(['press@5,6', 'release@5,6'])
		stop()
	})

	it('does nothing for a stream that is not a terminal', () => {
		const { stdin, stdout, written } = streams(false)
		const original = stdin.read
		installMouseWheel(stdin, stdout, () => undefined)()
		expect(written).toEqual([])
		expect(stdin.read).toBe(original)
	})
})
