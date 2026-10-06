import { describe, expect, it } from 'vitest'

import { cloneJsonValue } from './json-snapshot.js'

/**
 * `ToolManager` clones prepared output through this function, and asynchronous
 * preparation also detaches JSON-compatible raw input before validation yields.
 * These two cases moved with it from `registry/tool/execute.ts`'s `execute.test.ts`:
 * a getter defined on an array index must never run during cloning (it could
 * return a different value on a later read, after review already looked at
 * the first one), and a non-enumerable array element must be refused rather
 * than silently treated as absent.
 */
describe('cloneJsonValue', () => {
	it('refuses array accessors without invoking them', () => {
		let getterRuns = 0
		const value: unknown[] = []
		Object.defineProperty(value, '0', {
			enumerable: true,
			configurable: true,
			get() {
				getterRuns++
				return 'value'
			},
		})
		value.length = 1

		expect(() => cloneJsonValue(value, true)).toThrow(/enumerable data property/i)
		expect(getterRuns).toBe(0)
	})

	it('refuses non-enumerable array elements', () => {
		const value: unknown[] = []
		Object.defineProperty(value, '0', {
			enumerable: false,
			configurable: true,
			value: 'hidden',
		})
		value.length = 1

		expect(() => cloneJsonValue(value, true)).toThrow(/enumerable data property/i)
	})

	it('refuses a getter defined on a plain object property the same way', () => {
		let getterRuns = 0
		const value = {}
		Object.defineProperty(value, 'k', {
			enumerable: true,
			configurable: true,
			get() {
				getterRuns++
				return 'value'
			},
		})

		expect(() => cloneJsonValue(value, true)).toThrow(/enumerable data property/i)
		expect(getterRuns).toBe(0)
	})

	it('clones an ordinary array and object unchanged', () => {
		const value = { a: 1, b: ['x', 'y'], c: { nested: true } }
		const cloned = cloneJsonValue(value, true)
		expect(cloned).toEqual(value)
		expect(cloned).not.toBe(value)
	})

	it('preserves nested raw prototypes only when requested', () => {
		const nested = Object.assign(Object.create(null), { value: 'original' })
		const raw = Object.assign(Object.create(null), { ordinary: { nested: [nested] } })
		const snapshot = cloneJsonValue(raw, false, '$', true) as typeof raw
		expect(Object.getPrototypeOf(snapshot)).toBe(null)
		expect(Object.getPrototypeOf(snapshot.ordinary)).toBe(Object.prototype)
		expect(Object.getPrototypeOf(snapshot.ordinary.nested[0])).toBe(null)
		expect(snapshot.ordinary.nested[0]).not.toBe(nested)
		const output = cloneJsonValue(snapshot, true) as typeof raw
		expect(Object.getPrototypeOf(output)).toBe(Object.prototype)
		expect(Object.getPrototypeOf(output.ordinary.nested[0])).toBe(Object.prototype)
		expect(Object.isFrozen(output.ordinary.nested[0])).toBe(true)
	})

	it('does not invoke getters or accept custom prototypes while preserving raw prototypes', () => {
		let getterRuns = 0
		const raw = Object.create(null)
		Object.defineProperty(raw, 'value', {
			enumerable: true,
			get() {
				getterRuns++
				return 'hidden'
			},
		})
		expect(() => cloneJsonValue(raw, false, '$', true)).toThrow(/enumerable data property/)
		expect(getterRuns).toBe(0)
		expect(() => cloneJsonValue(new Date(0), false, '$', true)).toThrow(/plain JSON object/)
	})

	it.each(['subclass', 'null-prototype'] as const)(
		'leaves %s arrays to raw schema semantics but keeps final array canonicalization',
		(kind) => {
			class HostArray extends Array<string> {}
			const raw = kind === 'subclass' ? new HostArray('value') : ['value']
			if (kind === 'null-prototype') Object.setPrototypeOf(raw, null)
			expect(() => cloneJsonValue(raw, false, '$', true)).toThrow(/ordinary array/)
			const output = cloneJsonValue(raw, true)
			expect(output).toEqual(['value'])
			expect(Object.getPrototypeOf(output)).toBe(Array.prototype)
			expect(Object.isFrozen(output)).toBe(true)
		},
	)
})
