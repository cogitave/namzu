import { describe, expect, it } from 'vitest'

import { entityIdPattern } from '../id-format.js'
import { createUuidV7Generator, uuidv7, uuidv7Timestamp } from '../uuidv7.js'

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('UUIDv7 ids', () => {
	it('carries the clock, version 7 and the RFC variant, and passes the entity id check', () => {
		const at = Date.UTC(2026, 8, 21, 12, 0, 0)
		const next = createUuidV7Generator({ now: () => at })
		const id = next()
		expect(id).toMatch(V7)
		expect(entityIdPattern().test(id)).toBe(true)
		expect(uuidv7Timestamp(id)).toBe(at)
	})

	it('is strictly increasing within one millisecond', () => {
		const next = createUuidV7Generator({ now: () => 1_700_000_000_000 })
		const ids = Array.from({ length: 10_000 }, () => next())
		for (let i = 1; i < ids.length; i += 1) {
			expect((ids[i] as string) > (ids[i - 1] as string), `${ids[i - 1]} < ${ids[i]}`).toBe(true)
		}
		expect(new Set(ids).size).toBe(ids.length)
	})

	it('keeps counting forward when the wall clock steps back', () => {
		let clock = 2_000_000
		const next = createUuidV7Generator({ now: () => clock })
		const before = next()
		clock -= 1_000
		const after = next()
		expect(after > before).toBe(true)
		expect(uuidv7Timestamp(after)).toBe(2_000_000)
	})

	it('seeds a new millisecond in the lower half of the counter, leaving 2^41 ids of headroom', () => {
		// Randomness of all ones is the largest possible seed.
		const next = createUuidV7Generator({
			now: () => 5_000,
			random: (bytes) => bytes.fill(0xff),
		})
		const seeded = next()
		// The counter's top bit is the top bit of the 12-bit rand_a field.
		expect(seeded.slice(15, 18)).toBe('7ff')
		expect(seeded.slice(19, 23)).toBe('bfff')
		const following = next()
		expect(following.slice(15, 18)).toBe('800')
		expect(following > seeded).toBe(true)
		expect(uuidv7Timestamp(following)).toBe(5_000)
	})

	it('sorts by creation time across milliseconds', () => {
		let clock = 10
		const next = createUuidV7Generator({ now: () => clock })
		const first = next()
		clock = 11
		const second = next()
		expect([second, first].sort()).toEqual([first, second])
	})

	it('refuses a clock outside the 48-bit field', () => {
		expect(() => createUuidV7Generator({ now: () => -1 })()).toThrow(RangeError)
		expect(() => createUuidV7Generator({ now: () => 2 ** 48 })()).toThrow(RangeError)
	})

	it('reads no timestamp from a UUID of another version', () => {
		expect(uuidv7Timestamp('550e8400-e29b-41d4-a716-446655440000')).toBeUndefined()
		expect(uuidv7Timestamp(uuidv7())).toBeTypeOf('number')
	})
})
