import { expect, it } from 'vitest'
import { isNewModel } from './model-freshness.js'

const DAY = 24 * 60 * 60 * 1000
const seen = '2026-10-01T00:00:00.000Z'
const at = Date.parse(seen)

it('marks a model new for seven days after it was first seen, then stops', () => {
	expect(isNewModel(seen, at)).toBe(true)
	expect(isNewModel(seen, at + 7 * DAY - 1)).toBe(true)
	expect(isNewModel(seen, at + 7 * DAY)).toBe(false)
	expect(isNewModel(seen, at + 30 * DAY)).toBe(false)
})

it('marks nothing without a first-seen time, or with one that cannot be read', () => {
	expect(isNewModel(undefined, at)).toBe(false)
	expect(isNewModel('not a date', at)).toBe(false)
})

it('keeps a future stamp new rather than hiding it after a clock change', () => {
	expect(isNewModel(seen, at - DAY)).toBe(true)
})

it('does not keep the chip for years when the clock was once set far ahead', () => {
	expect(isNewModel(new Date(at + 400 * DAY).toISOString(), at)).toBe(false)
})
