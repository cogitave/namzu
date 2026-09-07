import { describe, expect, it } from 'vitest'

import { encodeCodeValue } from '../json-value.js'
import { WorkerCodeRuntime } from '../worker.js'

describe('bounded JSON transport', () => {
	it('preserves JSON values and permits repeated references without cycles', () => {
		const shared = { value: '😀', zero: 0, no: false }
		const value = [shared, shared, null]
		expect(JSON.parse(encodeCodeValue(value, 256) ?? '')).toEqual(value)
		expect(encodeCodeValue(undefined, 1)).toBeUndefined()
	})

	it('counts escaping and UTF-8 bytes before returning the serialized value', () => {
		expect(encodeCodeValue('😀', 6)).toBe('"😀"')
		expect(() => encodeCodeValue('😀', 5)).toThrow('exceeds')
		expect(() => encodeCodeValue('\n', 3)).toThrow('exceeds')
	})

	it.each([
		1n,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		() => 1,
		Symbol('x'),
		new Map(),
		{ value: undefined },
	])('refuses unsupported values: %s', (value) => {
		expect(() => encodeCodeValue(value, 256)).toThrow()
	})

	it('refuses cycles and accessors without invoking the accessor', () => {
		const cycle: { self?: unknown } = {}
		cycle.self = cycle
		expect(() => encodeCodeValue(cycle, 256)).toThrow('cycles')
		let invoked = false
		const accessor = {
			get value() {
				invoked = true
				return 1
			},
		}
		expect(() => encodeCodeValue(accessor, 256)).toThrow('accessors')
		expect(invoked).toBe(false)
	})

	it('refuses excessive nesting without overflowing the host stack', () => {
		let value: unknown = null
		for (let depth = 0; depth < 100; depth++) value = [value]
		expect(() => encodeCodeValue(value, 1024)).toThrow('nesting')
	})
})

describe('runtime policy validation', () => {
	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 10_001])(
		'rejects invalid call caps: %s',
		(maxHostCalls) => {
			expect(() => new WorkerCodeRuntime({ maxHostCalls })).toThrow(RangeError)
		},
	)
	it('rejects concurrent caps greater than the total and unsafe memory budgets', () => {
		expect(() => new WorkerCodeRuntime({ maxHostCalls: 1, maxPendingHostCalls: 2 })).toThrow(
			RangeError,
		)
		expect(() => new WorkerCodeRuntime({ memoryLimitBytes: 1024 })).toThrow(RangeError)
		expect(() => new WorkerCodeRuntime({ memoryLimitBytes: 1024 * 1024 * 1024 })).toThrow(
			RangeError,
		)
	})
})
