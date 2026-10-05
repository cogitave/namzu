import { expect, it } from 'vitest'
import type { ConversationView, ProjectView } from '../shared/protocol.js'
import {
	PalCatalogueActivity,
	latestPalConversation,
	mergeConversationCatalogues,
	warmPalConversation,
} from './pal-navigation.js'
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

it('requires a confirmed unchanged catalogue to target a conversation after its tab closed', () => {
	const activity = new PalCatalogueActivity()
	const find = () =>
		activity.confirmedCurrent('pal')
			? latestPalConversation('pal', [project], [older, latest])
			: undefined
	// Existing admitted tabs retain their initial warm-route semantics; a removed
	// tab cannot use that default as proof that its catalogue was ever read.
	expect(activity.current('pal')).toBe(true)
	expect(activity.confirmedCurrent('pal')).toBe(false)
	expect(find()).toBeUndefined()
	const initial = activity.ticket('pal')
	expect(activity.confirm('pal', initial)).toBe(true)
	expect(find()).toBe(latest)
	activity.changed('pal')
	expect(activity.confirmedCurrent('pal')).toBe(false)
	expect(find()).toBeUndefined()
	expect(activity.confirm('pal', initial)).toBe(false)
	expect(find()).toBeUndefined()
	expect(activity.confirm('pal', activity.ticket('pal'))).toBe(true)
	expect(find()).toBe(latest)
	// Connection replacement and Pal edits use the same explicit invalidation.
	activity.changed('pal')
	expect(find()).toBeUndefined()
	expect(activity.confirmedCurrent('other')).toBe(false)
})

it('finds the latest Pal target independently of open tabs without substituting an older admitted conversation', () => {
	const rows = [latest, older]
	expect(latestPalConversation('pal', [project], rows)).toBe(latest)
	expect(rows).toEqual([latest, older])
	expect(warmPalConversation('pal', [project], rows, ['older'], () => true)).toBeUndefined()
	expect(
		warmPalConversation('pal', [project], rows, ['older', 'latest'], (view) => view.id === 'older'),
	).toBeUndefined()
})

it('refuses latest-target discovery for ambiguous, unavailable, untrusted or foreign Pal projects', () => {
	expect(
		latestPalConversation('pal', [project, { ...project, id: 'other' }], [latest]),
	).toBeUndefined()
	for (const unavailable of [
		{ ...project, status: 'connecting' as const },
		{ ...project, status: 'error' as const },
		{ ...project, trusted: false },
		{ ...project, palId: 'other' },
	])
		expect(latestPalConversation('pal', [unavailable], [latest])).toBeUndefined()
	expect(latestPalConversation('pal', [project], [])).toBeUndefined()
	expect(latestPalConversation('pal', [project], [{ ...latest, palId: undefined }])).toBeUndefined()
	expect(
		latestPalConversation('pal', [project], [{ ...latest, projectId: 'other' }]),
	).toBeUndefined()
})

it('replaces a successfully refreshed catalogue before discovering its latest target', () => {
	const other = { ...latest, id: 'other', projectId: 'other-project', palId: 'other-pal' }
	const failed = { ...latest, id: 'failed', projectId: 'failed-project', palId: 'failed-pal' }
	const current = [latest, older, other, failed]
	const refreshed = [older]
	const merged = mergeConversationCatalogues(current, refreshed, [project.id])
	expect(merged).toEqual([older, other, failed])
	expect(latestPalConversation('pal', [project], merged)).toBe(older)
	expect(current).toEqual([latest, older, other, failed])
	expect(refreshed).toEqual([older])
})

it('removes an empty successful catalogue and preserves failed or unread projects', () => {
	const other = { ...latest, id: 'other', projectId: 'other-project', palId: 'other-pal' }
	expect(mergeConversationCatalogues([latest, other], [], [project.id])).toEqual([other])
	expect(mergeConversationCatalogues([latest, other], [], [])).toEqual([latest, other])
	expect(mergeConversationCatalogues([latest, other], [older, other], [project.id])).toEqual([
		older,
		other,
	])
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
