/**
 * The level hypermode pins: `xhigh`, or the highest published level below it
 * on a model whose menu has no `xhigh` — never `max` or `ultra` over a lower
 * level — and the picker stop names exactly that level.
 */

import { describe, expect, it } from 'vitest'

import { HYPERMODE_EFFORT, hypermodeEffort, hypermodeStopLabel } from './hypermode.js'

describe('the level hypermode pins', () => {
	it.each([
		[['low', 'medium', 'high', 'xhigh', 'max'], 'xhigh'],
		[['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'xhigh'],
		[['low', 'medium', 'high', 'xhigh'], 'xhigh'],
		[['medium', 'xhigh'], 'xhigh'],
		[['low', 'high'], 'high'],
		[['low', 'medium', 'high', 'max'], 'high'],
		[['minimal', 'low'], 'low'],
		// Every level above xhigh: the nearest there is.
		[['max', 'ultra'], 'max'],
	] as const)('%j → %s', (levels, pinned) => {
		expect(hypermodeEffort(levels)).toBe(pinned)
	})

	it('pins nothing without a published menu', () => {
		expect(hypermodeEffort(undefined)).toBeUndefined()
		expect(hypermodeEffort([])).toBeUndefined()
	})

	it('labels the stop with the level it pins', () => {
		expect(HYPERMODE_EFFORT).toBe('xhigh')
		expect(hypermodeStopLabel(hypermodeEffort(['low', 'high', 'xhigh', 'max']))).toBe(
			'xhigh + hypermode (workflows)',
		)
		expect(hypermodeStopLabel(hypermodeEffort(['low', 'high']))).toBe(
			'high + hypermode (workflows)',
		)
		expect(hypermodeStopLabel(undefined)).toBe('hypermode (workflows)')
	})
})
