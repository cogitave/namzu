import { describe, expect, it } from 'vitest'

import { SignalFilter, hostedByHost, spacesSignal } from '../signal.js'

describe('the private message a hosted session sends', () => {
	it('is stripped from the output and reported', () => {
		const filter = new SignalFilter()
		expect(filter.feed(`before${spacesSignal('zoom-out')}after`)).toEqual({
			text: 'beforeafter',
			signals: ['zoom-out'],
		})
	})

	it('passes ordinary output, including other escape sequences, through untouched', () => {
		const filter = new SignalFilter()
		const text = '\x1b[31mred\x1b[0m \x1b]0;title\x07 \x1b]7777;other;x\x07 end'
		expect(filter.feed(text)).toEqual({ text, signals: [] })
	})

	it('is found when the terminal cuts it anywhere', () => {
		const whole = `ab${spacesSignal('zoom-out')}cd`
		for (let cut = 1; cut < whole.length; cut++) {
			const filter = new SignalFilter()
			const first = filter.feed(whole.slice(0, cut))
			const second = filter.feed(whole.slice(cut))
			expect(first.text + second.text).toBe('abcd')
			expect([...first.signals, ...second.signals]).toEqual(['zoom-out'])
		}
	})

	it('is found when sent three bytes at a time', () => {
		const filter = new SignalFilter()
		const whole = `x${spacesSignal('zoom-out')}y`
		let text = ''
		const signals: string[] = []
		for (let i = 0; i < whole.length; i += 3) {
			const out = filter.feed(whole.slice(i, i + 3))
			text += out.text
			signals.push(...out.signals)
		}
		expect(text).toBe('xy')
		expect(signals).toEqual(['zoom-out'])
	})

	it('accepts the string terminator as well as the bell', () => {
		const filter = new SignalFilter()
		expect(filter.feed('a\x1b]7777;namzu-spaces;zoom-out\x1b\\b')).toEqual({
			text: 'ab',
			signals: ['zoom-out'],
		})
	})

	it('lets a lone escape through when what follows is not ours', () => {
		const filter = new SignalFilter()
		expect(filter.feed('a\x1b')).toEqual({ text: 'a', signals: [] })
		expect(filter.feed('[2Jb')).toEqual({ text: '\x1b[2Jb', signals: [] })
	})

	it('releases an unknown message of ours unchanged', () => {
		const filter = new SignalFilter()
		const text = '\x1b]7777;namzu-spaces;nonsense\x07'
		expect(filter.feed(text)).toEqual({ text, signals: [] })
	})

	it('finds two in one chunk', () => {
		const filter = new SignalFilter()
		const one = spacesSignal('zoom-out')
		expect(filter.feed(`${one}x${one}`)).toEqual({
			text: 'x',
			signals: ['zoom-out', 'zoom-out'],
		})
	})
})

describe('knowing the terminal belongs to a host', () => {
	it('needs the slot and the host as the direct parent', () => {
		expect(hostedByHost({ NAMZU_SPACE_SLOT: 's', NAMZU_SPACE_HOST_PID: '42' }, 42)).toBe(true)
		// A run started from inside a hosted session inherits the environment but has another parent.
		expect(hostedByHost({ NAMZU_SPACE_SLOT: 's', NAMZU_SPACE_HOST_PID: '42' }, 43)).toBe(false)
		expect(hostedByHost({ NAMZU_SPACE_HOST_PID: '42' }, 42)).toBe(false)
		expect(hostedByHost({}, 42)).toBe(false)
	})
})
