import { describe, expect, it } from 'vitest'
import { InputRouter } from '../input.js'
import { DEFAULT_PREFIX, parsePrefix } from '../prefix.js'

describe('parsePrefix', () => {
	it('reads ctrl+letter and ctrl+space, in any case', () => {
		expect(parsePrefix('ctrl+b')).toEqual({ name: 'ctrl+b', byte: '\x02' })
		expect(parsePrefix('Ctrl+A')).toEqual({ name: 'ctrl+a', byte: '\x01' })
		expect(parsePrefix('ctrl + space')).toEqual({ name: 'ctrl+space', byte: '\x00' })
	})

	it('refuses keys the session needs or that are other keys', () => {
		for (const bad of [
			'ctrl+c',
			'ctrl+d',
			'ctrl+z',
			'ctrl+i',
			'ctrl+m',
			'ctrl+[',
			'b',
			'alt+b',
			'',
		])
			expect(parsePrefix(bad)).toBeUndefined()
	})
})

describe('InputRouter', () => {
	const router = () => new InputRouter(DEFAULT_PREFIX)

	it('passes typed bytes through untouched, escape sequences included', () => {
		expect(router().feed('hi\x1b[A\r')).toEqual([{ type: 'write', data: 'hi\x1b[A\r' }])
	})

	it('enters navigate mode on the prefix and keeps what came before it', () => {
		const r = router()
		expect(r.feed('ab\x02')).toEqual([
			{ type: 'write', data: 'ab' },
			{ type: 'mode', mode: 'navigate' },
		])
		expect(r.current).toBe('navigate')
	})

	it('sends a literal prefix when it is pressed twice in a row', () => {
		const r = router()
		expect(r.feed('\x02\x02')).toEqual([
			{ type: 'mode', mode: 'navigate' },
			{ type: 'mode', mode: 'terminal' },
			{ type: 'write', data: '\x02' },
		])
	})

	it('only leaves, without a literal prefix, when another navigate key came between', () => {
		const r = router()
		r.feed('\x02')
		r.feed('j')
		expect(r.feed('\x02')).toEqual([{ type: 'mode', mode: 'terminal' }])
	})

	it('reads navigate keys, and leaves on escape or on enter and l', () => {
		const r = router()
		r.feed('\x02')
		expect(r.feed('j\x1b[Ak')).toEqual([
			{ type: 'nav', key: { kind: 'char', char: 'j' } },
			{ type: 'nav', key: { kind: 'up' } },
			{ type: 'nav', key: { kind: 'char', char: 'k' } },
		])
		expect(r.feed('\x1b')).toEqual([{ type: 'mode', mode: 'terminal' }])
		r.feed('\x02')
		expect(r.feed('l')).toEqual([
			{ type: 'nav', key: { kind: 'char', char: 'l' } },
			{ type: 'mode', mode: 'terminal' },
		])
	})

	it('swallows unknown escape sequences whole in navigate mode', () => {
		const r = router()
		r.feed('\x02')
		expect(r.feed('\x1b[1;5C')).toEqual([{ type: 'nav', key: { kind: 'char', char: '' } }])
	})

	it('does not read the prefix inside a bracketed paste, even across chunks', () => {
		const r = router()
		expect(r.feed('\x1b[200~a\x02')).toEqual([{ type: 'write', data: '\x1b[200~a\x02' }])
		expect(r.feed('b\x1b[201~')).toEqual([{ type: 'write', data: 'b\x1b[201~' }])
		expect(r.feed('\x02')).toEqual([{ type: 'mode', mode: 'navigate' }])
	})

	it('follows a changed prefix', () => {
		const r = new InputRouter(parsePrefix('ctrl+space') as never)
		expect(r.feed('\x02')).toEqual([{ type: 'write', data: '\x02' }])
		expect(r.feed('\x00')).toEqual([{ type: 'mode', mode: 'navigate' }])
	})

	it('reads pointer reports in both modes and keeps them out of the session', () => {
		const r = router()
		expect(r.feed('a\x1b[<0;12;3Mb')).toEqual([
			{ type: 'write', data: 'a' },
			{ type: 'mouse', mouse: { kind: 'press', x: 11, y: 2 } },
			{ type: 'write', data: 'b' },
		])
		expect(r.feed('\x1b[<0;12;3m')).toEqual([
			{ type: 'mouse', mouse: { kind: 'release', x: 11, y: 2 } },
		])
		expect(r.feed('\x1b[<64;1;1M\x1b[<65;1;1M')).toEqual([
			{ type: 'mouse', mouse: { kind: 'wheel-up', x: 0, y: 0 } },
			{ type: 'mouse', mouse: { kind: 'wheel-down', x: 0, y: 0 } },
		])
		r.feed('\x02')
		expect(r.feed('\x1b[<0;2;2M')).toEqual([
			{ type: 'mouse', mouse: { kind: 'press', x: 1, y: 1 } },
		])
		expect(r.current).toBe('navigate')
	})

	it('waits for the rest of a pointer report that arrived in two pieces', () => {
		const r = router()
		expect(r.feed('x\x1b[<0;1')).toEqual([{ type: 'write', data: 'x' }])
		expect(r.feed('2;3M')).toEqual([{ type: 'mouse', mouse: { kind: 'press', x: 11, y: 2 } }])
	})

	it('hands typed text to the host while capturing, without leaving navigate mode', () => {
		const r = router()
		r.feed('\x02')
		r.capture(true)
		expect(r.feed('a\x7f\r\x1b')).toEqual([
			{ type: 'nav', key: { kind: 'char', char: 'a' } },
			{ type: 'nav', key: { kind: 'backspace' } },
			{ type: 'nav', key: { kind: 'enter' } },
			{ type: 'nav', key: { kind: 'escape' } },
		])
		expect(r.current).toBe('navigate')
		r.capture(false)
		r.focus()
		expect(r.current).toBe('terminal')
	})
})
