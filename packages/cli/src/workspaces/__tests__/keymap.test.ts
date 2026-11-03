import { describe, expect, it } from 'vitest'
import { BINDINGS, bindingFor, helpRows, keyName } from '../keymap.js'

describe('the key map', () => {
	it('names keys the way the help shows them', () => {
		expect(keyName('N')).toBe('shift+n')
		expect(keyName('v')).toBe('v')
		expect(keyName('-')).toBe('-')
		expect(keyName('backtab')).toBe('shift+tab')
	})

	it('binds no key twice', () => {
		const all = BINDINGS.flatMap((b) => b.keys)
		expect(new Set(all).size).toBe(all.length)
	})

	it('finds a binding for a key after the prefix', () => {
		expect(bindingFor({ kind: 'char', char: 'v' })?.action).toBe('split-side')
		expect(bindingFor({ kind: 'char', char: '7' })?.action).toBe('tab-number')
		expect(bindingFor({ kind: 'tab' })?.action).toBe('next-pane')
		expect(bindingFor({ kind: 'backtab' })?.action).toBe('prev-pane')
		expect(bindingFor({ kind: 'char', char: '!' })).toBeUndefined()
		expect(bindingFor({ kind: 'enter' })).toBeUndefined()
	})

	it('generates the help from the same list, with the prefix named', () => {
		const rows = helpRows('ctrl+a')
		expect(rows[0]?.heading).toContain('ctrl+a then a key')
		const labels = rows.flatMap((r) => (r.keys !== undefined ? [r.label] : []))
		expect(labels).toEqual(BINDINGS.map((b) => b.label))
		expect(rows.find((r) => r.label === 'tab by number')?.keys).toBe('1-9')
	})
})
