import { describe, expect, it } from 'vitest'
import { displayNameWarnings } from './validate.js'

describe('the display name never repeats Namzu', () => {
	it('warns for each language whose name starts with Namzu, and suggests the name without it', () => {
		const w = displayNameWarnings({ en: 'Namzu Activity', tr: 'Namzu Etkinlik' })
		expect(w).toHaveLength(2)
		expect(w[0]).toContain('"Activity"')
		expect(w[1]).toContain('"Etkinlik"')
	})
	it('is quiet for a name without it, and for a name that only contains the word later', () => {
		expect(displayNameWarnings({ en: 'Activity Tracker', tr: 'Activity Tracker' })).toEqual([])
		expect(displayNameWarnings({ en: 'Tracker for Namzu' })).toEqual([])
		expect(displayNameWarnings({ en: 'Namzuki Notes' })).toEqual([])
	})
})
