import { Autocomplete } from '@base-ui/react/autocomplete'
import { describe, expect, it } from 'vitest'
import { matchesCommandQuery, matchesCommandShortcut } from './command-palette-filter.js'

const { contains } = Autocomplete.useFilter({ sensitivity: 'base' })
describe('command palette search', () => {
	it('finds a chat using separate title and project terms without changing action identity', () => {
		const item = { label: 'Review permissions', group: 'Chats', meta: 'Workspace A' }
		expect(matchesCommandQuery(item, 'workspace permissions', contains)).toBe(true)
		expect(matchesCommandQuery(item, 'workspace missing', contains)).toBe(false)
	})
	it('matches accents, casing, extra whitespace and explicit context keywords', () => {
		const item = {
			label: 'Résumé review',
			group: 'Chats',
			keywords: ['read-only', 'project-alpha'],
		}
		expect(matchesCommandQuery(item, '  RESUME   alpha  ', contains)).toBe(true)
		expect(matchesCommandQuery(item, 'read-only', contains)).toBe(true)
		expect(matchesCommandQuery(item, '', contains)).toBe(true)
	})
	it('never matches absent context by coercing missing metadata to text', () => {
		const item = { label: 'New chat', group: 'Quick actions' }
		expect(matchesCommandQuery(item, 'undefined', contains)).toBe(false)
		expect(matchesCommandQuery(item, 'quick new', contains)).toBe(true)
	})
	it('honors exact platform shortcuts without taking ordinary input edits or alternate chords', () => {
		const controlN = { key: 'n', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }
		expect(matchesCommandShortcut(['Ctrl', 'N'], controlN)).toBe(true)
		expect(matchesCommandShortcut(['Cmd', 'N'], controlN)).toBe(false)
		expect(matchesCommandShortcut(['Ctrl', 'N'], { ...controlN, shiftKey: true })).toBe(false)
		expect(matchesCommandShortcut(['Ctrl', 'N'], { ...controlN, ctrlKey: false })).toBe(false)
		expect(matchesCommandShortcut(['Ctrl', 'N'], { ...controlN, key: 'o' })).toBe(false)
		expect(matchesCommandShortcut(['Meta', 'N'], controlN)).toBe(false)
	})
})
