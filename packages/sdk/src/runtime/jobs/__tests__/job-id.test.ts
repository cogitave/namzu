import { describe, expect, it } from 'vitest'

import { createBackgroundJobId, invalidBackgroundJobIdInput, isBackgroundJobId } from '../job-id.js'

describe('background job ids', () => {
	it('are a type tag and eight base36 characters', () => {
		for (let i = 0; i < 200; i += 1) {
			expect(createBackgroundJobId()).toMatch(/^b[0-9a-z]{8}$/)
		}
	})

	it('do not repeat across many draws', () => {
		const seen = new Set<string>()
		for (let i = 0; i < 5000; i += 1) seen.add(createBackgroundJobId())
		expect(seen.size).toBe(5000)
	})

	it('never returns an id the caller says is taken', () => {
		const first = createBackgroundJobId()
		let refused = 0
		const next = createBackgroundJobId((id) => {
			if (refused < 3) {
				refused += 1
				return true
			}
			return id === first
		})
		expect(refused).toBe(3)
		expect(next).not.toBe(first)
	})

	it('validator accepts only that shape', () => {
		expect(isBackgroundJobId('b1k3x9q2z')).toBe(true)
		for (const bad of [
			'job_1',
			'b1k3x9q2',
			'b1k3x9q2zz',
			'B1k3x9q2z',
			'a1k3x9q2z',
			'b1k3x9q2-',
			'',
			'../b1k3x9q2z',
		]) {
			expect(isBackgroundJobId(bad)).toBe(false)
		}
		expect(isBackgroundJobId(undefined)).toBe(false)
		expect(isBackgroundJobId(42)).toBe(false)
	})

	it('input check refuses only what cannot be an id', () => {
		for (const bad of [undefined, 42, '', 'a b', 'a\nb', 'a\u0000b', 'x'.repeat(129)]) {
			expect(invalidBackgroundJobIdInput(bad)).toEqual(expect.any(String))
		}
		for (const fine of ['job_1', 'b1k3x9q2z', 'host-id/7', 'x'.repeat(128)]) {
			expect(invalidBackgroundJobIdInput(fine)).toBeUndefined()
		}
	})
})
