import { expect, it } from 'vitest'
import { archivedDate } from './archived-conversations-dialog.js'

it('shows a day for a valid date and nothing for one that does not parse', () => {
	expect(archivedDate('2026-09-18T12:00:00.000Z')).toMatch(/2026/)
	expect(archivedDate('not a date')).toBe('')
	expect(archivedDate('')).toBe('')
})
