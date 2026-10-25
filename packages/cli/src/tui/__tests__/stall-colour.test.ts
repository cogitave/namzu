import { describe, expect, it } from 'vitest'

import { blendTowardStall, easeStall, stallTarget } from '../stall-colour.js'

describe('stall colour', () => {
	it('starts after 10 s and is full at 20 s', () => {
		const at = (ms: number) => stallTarget({ sinceLastTokenMs: ms, exempt: false })
		expect(at(9_000)).toBe(0)
		expect(at(10_000)).toBe(0)
		expect(at(15_000)).toBe(0.5)
		expect(at(20_000)).toBe(1)
		expect(at(90_000)).toBe(1)
	})

	it('never tints while a tool runs, thinking, compacting or paused', () => {
		expect(stallTarget({ sinceLastTokenMs: 60_000, exempt: true })).toBe(0)
	})

	it('eases by 10% of the gap per 50 ms and lands on the target', () => {
		expect(easeStall(0, 1, 49)).toBe(0)
		expect(easeStall(0, 1, 50)).toBeCloseTo(0.1, 5)
		expect(easeStall(0, 1, 100)).toBeCloseTo(0.19, 5)
		expect(easeStall(0.999, 1, 50)).toBe(1)
		expect(easeStall(1, 0, 10_000)).toBe(0)
	})

	it('blends a base colour toward rgb(171,43,63)', () => {
		expect(blendTowardStall([255, 255, 255], 0)).toBe('rgb(255,255,255)')
		expect(blendTowardStall([255, 255, 255], 1)).toBe('rgb(171,43,63)')
		expect(blendTowardStall([0, 0, 0], 0.5)).toBe('rgb(86,22,32)')
	})
})
