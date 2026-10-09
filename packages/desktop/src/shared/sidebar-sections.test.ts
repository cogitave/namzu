import { describe, expect, it } from 'vitest'
import { collapsedSectionsFrom, isSidebarSection } from './sidebar-sections.js'

describe('collapsedSectionsFrom', () => {
	it('keeps known sections once each, in the sidebar order', () => {
		expect(collapsedSectionsFrom(['recents', 'pals', 'recents'])).toEqual(['pals', 'recents'])
		expect(collapsedSectionsFrom(['projects'])).toEqual(['projects'])
	})
	it('reads a missing or invalid value as nothing folded', () => {
		for (const bad of [undefined, null, 'pals', 3, {}, [], ['Pals'], ['x', 4, null]])
			expect(collapsedSectionsFrom(bad)).toEqual([])
	})
	it('drops unknown names but keeps the valid ones next to them', () => {
		expect(collapsedSectionsFrom(['future-section', 'projects', 9])).toEqual(['projects'])
	})
})

it('recognises only the three sections', () => {
	expect(['pals', 'projects', 'recents'].every(isSidebarSection)).toBe(true)
	expect(isSidebarSection('archive')).toBe(false)
	expect(isSidebarSection(undefined)).toBe(false)
})
