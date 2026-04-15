import { describe, expect, it } from 'vitest'
import { parseKeyCombo } from '../adapters/darwin.js'

describe('parseKeyCombo', () => {
	it('parses a bare key', () => {
		expect(parseKeyCombo('Return')).toEqual({ modifiers: [], mainKey: 'Return' })
		expect(parseKeyCombo('a')).toEqual({ modifiers: [], mainKey: 'a' })
	})

	it('parses single modifier combos', () => {
		expect(parseKeyCombo('cmd+c')).toEqual({ modifiers: ['command'], mainKey: 'c' })
		expect(parseKeyCombo('ctrl+v')).toEqual({ modifiers: ['control'], mainKey: 'v' })
		expect(parseKeyCombo('alt+Tab')).toEqual({ modifiers: ['option'], mainKey: 'Tab' })
		expect(parseKeyCombo('shift+Home')).toEqual({ modifiers: ['shift'], mainKey: 'Home' })
	})

	it('parses multi-modifier combos in order', () => {
		expect(parseKeyCombo('ctrl+shift+t')).toEqual({
			modifiers: ['control', 'shift'],
			mainKey: 't',
		})
		expect(parseKeyCombo('cmd+alt+shift+4')).toEqual({
			modifiers: ['command', 'option', 'shift'],
			mainKey: '4',
		})
	})

	it('normalises modifier aliases (meta/super/win → command, opt → option)', () => {
		expect(parseKeyCombo('meta+c').modifiers).toEqual(['command'])
		expect(parseKeyCombo('super+c').modifiers).toEqual(['command'])
		expect(parseKeyCombo('win+c').modifiers).toEqual(['command'])
		expect(parseKeyCombo('opt+c').modifiers).toEqual(['option'])
		expect(parseKeyCombo('Control+c').modifiers).toEqual(['control'])
	})

	it('throws on unknown modifier', () => {
		expect(() => parseKeyCombo('hyper+c')).toThrow(/unknown modifier/)
	})

	it('throws on empty input', () => {
		expect(() => parseKeyCombo('')).toThrow(/empty/)
		expect(() => parseKeyCombo('+++')).toThrow(/empty/)
	})
})
