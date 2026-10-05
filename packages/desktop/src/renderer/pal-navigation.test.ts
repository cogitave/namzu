import { expect, it } from 'vitest'
import type { ConversationView, ProjectView } from '../shared/protocol.js'
import { PalCatalogueActivity, warmPalConversation } from './pal-navigation.js'
import { WorkspaceSessionCache } from './workspace-session-cache.js'

const project: ProjectView = {
	id: 'workspace',
	name: 'Pal',
	path: '/pal',
	palId: 'pal',
	trusted: true,
	status: 'ready',
}
const conversation = (id: string, updatedAt: string): ConversationView => ({
	id,
	projectId: project.id,
	palId: 'pal',
	title: 'Pal',
	updatedAt,
})
const older = conversation('older', '2026-10-01T10:00:00Z')
const latest = conversation('latest', '2026-10-05T10:00:00Z')

it('keeps catalogue freshness until activity is confirmed by a matching read', () => {
	const activity = new PalCatalogueActivity()
	expect(activity.current('pal')).toBe(true)
	const initial = activity.ticket('pal')
	activity.changed('pal')
	expect(activity.current('pal')).toBe(false)
	expect(activity.confirm('pal', initial)).toBe(false)
	expect(activity.current('pal')).toBe(false)
	const read = activity.ticket('pal')
	expect(activity.confirm('pal', read)).toBe(true)
	expect(activity.current('pal')).toBe(true)
})

it('does not let a stale concurrent catalogue read confirm activity', () => {
	const activity = new PalCatalogueActivity()
	activity.changed('pal')
	const read = activity.ticket('pal')
	activity.changed('pal')
	expect(activity.confirm('pal', read)).toBe(false)
	expect(activity.current('pal')).toBe(false)
	const latestRead = activity.ticket('pal')
	expect(activity.confirm('pal', latestRead)).toBe(true)
	expect(activity.current('pal')).toBe(true)
})

it('tracks catalogue activity independently for each Pal', () => {
	const activity = new PalCatalogueActivity()
	activity.changed('pal')
	expect(activity.current('pal')).toBe(false)
	expect(activity.current('other')).toBe(true)
	expect(activity.confirm('other', activity.ticket('other'))).toBe(true)
	expect(activity.current('pal')).toBe(false)
})

it('revisits the latest admitted Pal tab without mutating recency or its catalogue', () => {
	const rows = [older, latest]
	expect(warmPalConversation('pal', [project], rows, ['older', 'latest'], () => true)).toBe(latest)
	expect(rows).toEqual([older, latest])
})

it('does not adopt another pane, an ordinary session, or an unavailable Pal project', () => {
	expect(
		warmPalConversation(
			'pal',
			[project, { ...project, id: 'other' }],
			[latest],
			['latest'],
			() => true,
		),
	).toBeUndefined()
	expect(warmPalConversation('pal', [project], [latest], [], () => true)).toBeUndefined()
	expect(
		warmPalConversation(
			'pal',
			[project],
			[{ ...latest, palId: undefined }],
			['latest'],
			() => true,
		),
	).toBeUndefined()
	expect(
		warmPalConversation(
			'pal',
			[project],
			[{ ...latest, projectId: 'other' }],
			['latest'],
			() => true,
		),
	).toBeUndefined()
	for (const unavailable of [
		{ ...project, status: 'error' as const },
		{ ...project, trusted: false },
		{ ...project, palId: 'other' },
	])
		expect(
			warmPalConversation('pal', [unavailable], [latest], ['latest'], () => true),
		).toBeUndefined()
})

it('uses the full opening path when a newer conversation has not been admitted', () => {
	expect(
		warmPalConversation('pal', [project], [older, latest], ['older'], () => true),
	).toBeUndefined()
	expect(
		warmPalConversation(
			'pal',
			[project],
			[older, latest],
			['older', 'latest'],
			(view) => view.id === 'older',
		),
	).toBeUndefined()
})

it('never reuses an admission during model changes, after reconnect, or after a tab leaves the pane', () => {
	const cache = new WorkspaceSessionCache<boolean>()
	cache.synchronizeMembers(['latest'])
	const admitted = (view: ConversationView) => Boolean(cache.read(view.id, view.projectId))
	const find = () => warmPalConversation('pal', [project], [latest], ['latest'], admitted)
	cache.remember(cache.ticket('latest', project.id), true)
	expect(find()).toBe(latest)
	const finish = cache.beginMutation('latest')
	expect(find()).toBeUndefined()
	finish()
	expect(find()).toBeUndefined()
	cache.remember(cache.ticket('latest', project.id), true)
	cache.invalidateProject(project.id)
	expect(find()).toBeUndefined()
	cache.remember(cache.ticket('latest', project.id), true)
	cache.synchronizeMembers([])
	expect(find()).toBeUndefined()
})
