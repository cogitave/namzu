import { describe, expect, it } from 'vitest'

import { cloneJsonValue } from './json-snapshot.js'

/**
 * `ToolManager.prepareExecution` clones a raw tool call's input through this
 * function before anything else touches it (`toolsets/manager.ts`'s
 * `prepareExecution`, via `cloneJsonValue` imported there as
 * `clonePreparedInput`) — the same admission `registry/tool/execute.ts` used
 * to run. These two cases moved with it from that file's `execute.test.ts`:
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
})
