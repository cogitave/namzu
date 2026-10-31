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

	it('waits for one key after the prefix, keeping what came before it', () => {
		const r = router()
		expect(r.feed('ab\x02')).toEqual([
			{ type: 'write', data: 'ab' },
			{ type: 'mode', mode: 'prefix' },
		])
		expect(r.current).toBe('prefix')
	})

	it('runs the key after the prefix as a command and goes back to the session', () => {
		const r = router()
		expect(r.feed('\x02v')).toEqual([
			{ type: 'mode', mode: 'prefix' },
			{ type: 'mode', mode: 'terminal' },
			{ type: 'nav', key: { kind: 'char', char: 'v' }, from: 'prefix' },
		])
		expect(r.current).toBe('terminal')
		expect(r.feed('x')).toEqual([{ type: 'write', data: 'x' }])
	})

	it('reads shift+tab and tab after the prefix', () => {
		const r = router()
		expect(r.feed('\x02\x1b[Z')[2]).toEqual({
			type: 'nav',
			key: { kind: 'backtab' },
			from: 'prefix',
		})
		expect(r.feed('\x02\t')[2]).toEqual({ type: 'nav', key: { kind: 'tab' }, from: 'prefix' })
	})

	it('sends a literal prefix when it is pressed twice in a row', () => {
		const r = router()
		expect(r.feed('\x02\x02')).toEqual([
			{ type: 'mode', mode: 'prefix' },
			{ type: 'mode', mode: 'terminal' },
			{ type: 'write', data: '\x02' },
		])
	})

	it('cancels the prefix on escape without sending anything', () => {
		const r = router()
		r.feed('\x02')
		expect(r.feed('\x1b')).toEqual([{ type: 'mode', mode: 'terminal' }])
	})

	it('starts the resize and navigate modes, which last until escape or enter', () => {
		const r = router()
		expect(r.feed('\x02r')).toEqual([
			{ type: 'mode', mode: 'prefix' },
			{ type: 'mode', mode: 'resize' },
			{ type: 'nav', key: { kind: 'char', char: 'r' }, from: 'prefix' },
		])
		expect(r.feed('hl\x1b[A')).toEqual([
			{ type: 'nav', key: { kind: 'char', char: 'h' }, from: 'resize' },
			{ type: 'nav', key: { kind: 'char', char: 'l' }, from: 'resize' },
			{ type: 'nav', key: { kind: 'up' }, from: 'resize' },
		])
		expect(r.feed('\x1b')).toEqual([{ type: 'mode', mode: 'terminal' }])
		r.feed('\x02w')
		expect(r.current).toBe('navigate')
		expect(r.feed('j\r')).toEqual([
			{ type: 'nav', key: { kind: 'char', char: 'j' }, from: 'navigate' },
			{ type: 'mode', mode: 'terminal' },
		])
	})

	it('swallows unknown escape sequences whole in a mode', () => {
		const r = router()
		r.feed('\x02r')
		expect(r.feed('\x1b[1;5C')).toEqual([
			{ type: 'nav', key: { kind: 'char', char: '' }, from: 'resize' },
		])
	})

	it('does not read the prefix inside a bracketed paste, even across chunks', () => {
		const r = router()
		expect(r.feed('\x1b[200~a\x02')).toEqual([{ type: 'write', data: '\x1b[200~a\x02' }])
		expect(r.feed('b\x1b[201~')).toEqual([{ type: 'write', data: 'b\x1b[201~' }])
		expect(r.feed('\x02')).toEqual([{ type: 'mode', mode: 'prefix' }])
	})

	it('follows a changed prefix', () => {
		const r = new InputRouter(parsePrefix('ctrl+space') as never)
		expect(r.feed('\x02')).toEqual([{ type: 'write', data: '\x02' }])
		expect(r.feed('\x00')).toEqual([{ type: 'mode', mode: 'prefix' }])
	})

	it('reads pointer reports in every mode and keeps them out of the session', () => {
		const r = router()
		expect(r.feed('a\x1b[<0;12;3Mb')).toEqual([
			{ type: 'write', data: 'a' },
			{ type: 'mouse', mouse: { kind: 'press', x: 11, y: 2 } },
			{ type: 'write', data: 'b' },
		])
		expect(r.feed('\x1b[<0;12;3m')).toEqual([
			{ type: 'mouse', mouse: { kind: 'release', x: 11, y: 2 } },
		])
		expect(r.feed('\x1b[<32;13;3M')).toEqual([
			{ type: 'mouse', mouse: { kind: 'drag', x: 12, y: 2 } },
		])
		expect(r.feed('\x1b[<64;1;1M\x1b[<65;1;1M')).toEqual([
			{ type: 'mouse', mouse: { kind: 'wheel-up', x: 0, y: 0 } },
			{ type: 'mouse', mouse: { kind: 'wheel-down', x: 0, y: 0 } },
		])
		r.feed('\x02r')
		expect(r.feed('\x1b[<0;2;2M')).toEqual([
			{ type: 'mouse', mouse: { kind: 'press', x: 1, y: 1 } },
		])
		expect(r.current).toBe('resize')
	})

	it('waits for the rest of a pointer report that arrived in two pieces', () => {
		const r = router()
		expect(r.feed('x\x1b[<0;1')).toEqual([{ type: 'write', data: 'x' }])
		expect(r.feed('2;3M')).toEqual([{ type: 'mouse', mouse: { kind: 'press', x: 11, y: 2 } }])
	})

	it('hands every key to the host while capturing, in any mode', () => {
		const r = router()
		r.capture(true)
		expect(r.feed('a\x7f\r\x1b\x02')).toEqual([
			{ type: 'nav', key: { kind: 'char', char: 'a' }, from: 'text' },
			{ type: 'nav', key: { kind: 'backspace' }, from: 'text' },
			{ type: 'nav', key: { kind: 'enter' }, from: 'text' },
			{ type: 'nav', key: { kind: 'escape' }, from: 'text' },
		])
		expect(r.current).toBe('terminal')
		r.capture(false)
		expect(r.feed('x')).toEqual([{ type: 'write', data: 'x' }])
	})
})
