import { describe, expect, it } from 'vitest'
import { translateKeyToSendKeys } from '../adapters/win32.js'

describe('translateKeyToSendKeys', () => {
	it('passes through bare printable characters', () => {
		expect(translateKeyToSendKeys('a')).toBe('a')
		expect(translateKeyToSendKeys('Z')).toBe('Z')
	})

	it('maps single modifier combos to SendKeys prefixes', () => {
		expect(translateKeyToSendKeys('ctrl+c')).toBe('^c')
		expect(translateKeyToSendKeys('shift+a')).toBe('+a')
		expect(translateKeyToSendKeys('alt+F4')).toBe('%{F4}')
	})

	it('chains multiple modifiers', () => {
		expect(translateKeyToSendKeys('ctrl+shift+t')).toBe('^+t')
		expect(translateKeyToSendKeys('ctrl+alt+delete')).toBe('^%{DELETE}')
	})

	it('translates cmd/meta/super to ^ (Windows ctrl equivalent)', () => {
		expect(translateKeyToSendKeys('cmd+c')).toBe('^c')
		expect(translateKeyToSendKeys('meta+v')).toBe('^v')
	})

	it('translates named keys to SendKeys special tokens', () => {
		expect(translateKeyToSendKeys('Return')).toBe('{ENTER}')
		expect(translateKeyToSendKeys('escape')).toBe('{ESC}')
		expect(translateKeyToSendKeys('tab')).toBe('{TAB}')
		expect(translateKeyToSendKeys('page_up')).toBe('{PGUP}')
		expect(translateKeyToSendKeys('up')).toBe('{UP}')
	})

	it('throws on unknown modifier', () => {
		expect(() => translateKeyToSendKeys('hyper+c')).toThrow(/unknown modifier/)
	})

	it('throws on empty input', () => {
		expect(() => translateKeyToSendKeys('')).toThrow(/empty/)
	})
})
