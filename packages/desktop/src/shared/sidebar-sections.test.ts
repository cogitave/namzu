import { describe, expect, it } from 'vitest'
import { collapsedSectionsFrom, isSidebarSection } from './sidebar-sections.js'

describe('collapsedSectionsFrom', () => {
	it('keeps known sections once each, in the sidebar order', () => {
		expect(collapsedSectionsFrom(['projects', 'pals', 'projects'])).toEqual(['pals', 'projects'])
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

it('recognises only the two foldable sections; Recents no longer folds', () => {
	expect(['pals', 'projects'].every(isSidebarSection)).toBe(true)
	expect(isSidebarSection('recents')).toBe(false)
	expect(collapsedSectionsFrom(['recents'])).toEqual([])
	expect(isSidebarSection('archive')).toBe(false)
	expect(isSidebarSection(undefined)).toBe(false)
})
