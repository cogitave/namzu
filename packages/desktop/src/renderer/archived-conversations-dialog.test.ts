import { expect, it } from 'vitest'
import { archivedDate, groupArchived } from './archived-conversations-dialog.js'

it('shows a day for a valid date and nothing for one that does not parse', () => {
	expect(archivedDate('2026-09-18T12:00:00.000Z')).toMatch(/2026/)
	expect(archivedDate('not a date')).toBe('')
	expect(archivedDate('')).toBe('')
})

it('groups archived conversations by project and puts the newest first', () => {
	const row = (id: string, projectId: string, updatedAt: string) => ({
		id,
		projectId,
		title: id,
		updatedAt,
	})
	const groups = groupArchived(
		[
			row('old', 'a', '2026-09-01T00:00:00Z'),
			row('other', 'b', '2026-09-05T00:00:00Z'),
			row('new', 'a', '2026-10-01T00:00:00Z'),
		],
		[
			{ id: 'a', name: 'Alpha' },
			{ id: 'b', name: 'Beta' },
			{ id: 'c', name: 'Empty' },
		],
	)
	expect(groups.map((group) => [group.name, group.rows.map((item) => item.id)])).toEqual([
		['Alpha', ['new', 'old']],
		['Beta', ['other']],
	])
})
