import { describe, expect, it } from 'vitest'
import type { ConversationView } from '../shared/protocol.js'
import {
	type ArchiveLoad,
	archiveEmptyText,
	archiveHeading,
	archiveSectionVisible,
	archiveToggleLabel,
	archivedRows,
	loadArchived,
	nextArchiveView,
	withArchived,
	withoutArchived,
} from './sidebar-archive.js'

const row = (id: string, projectId: string, updatedAt: string): ConversationView => ({
	id,
	projectId,
	title: id,
	updatedAt,
})

describe('archived rows', () => {
	it('lists every project together, newest first, each once', () => {
		const rows = archivedRows([
			row('old', 'a', '2026-09-01T00:00:00Z'),
			row('other', 'b', '2026-09-05T00:00:00Z'),
			row('new', 'a', '2026-10-01T00:00:00Z'),
			row('new', 'a', '2026-10-01T00:00:00Z'),
		])
		expect(rows.map((item) => item.id)).toEqual(['new', 'other', 'old'])
	})

	it('puts a row whose date does not parse last', () => {
		const rows = archivedRows([row('bad', 'a', 'nope'), row('good', 'a', '2026-01-01T00:00:00Z')])
		expect(rows.map((item) => item.id)).toEqual(['good', 'bad'])
	})

	it('adds an archived conversation at the front and drops a restored one', () => {
		const ready: ArchiveLoad = {
			status: 'ready',
			rows: [row('a', 'p', '2026-09-01T00:00:00Z')],
			unreadable: 1,
		}
		const added = withArchived(ready, row('b', 'p', '2026-10-01T00:00:00Z'))
		expect(added.status === 'ready' && added.rows.map((item) => item.id)).toEqual(['b', 'a'])
		expect(added.status === 'ready' && added.unreadable).toBe(1)
		const removed = withoutArchived(added, 'a')
		expect(removed.status === 'ready' && removed.rows.map((item) => item.id)).toEqual(['b'])
	})

	it('knows the archive after one archived conversation even before any read finished', () => {
		const added = withArchived({ status: 'loading' }, row('a', 'p', '2026-10-01T00:00:00Z'))
		expect(added.status === 'ready' && added.rows).toHaveLength(1)
		expect(withoutArchived({ status: 'loading' }, 'a')).toEqual({ status: 'loading' })
	})
})

describe('reading the archive', () => {
	it('stamps each row with the project it was read from', async () => {
		const load = await loadArchived(
			async (id) => [row(`${id}-1`, 'wrong', '2026-10-01T00:00:00Z')],
			[{ id: 'a' }, { id: 'b' }],
		)
		expect(load.status === 'ready' && load.rows.map((item) => item.projectId).sort()).toEqual([
			'a',
			'b',
		])
	})

	it('counts a project it could not read and keeps the rest', async () => {
		const load = await loadArchived(
			async (id) => {
				if (id === 'a') throw new Error('Error invoking remote method x: boom')
				return [row('kept', id, '2026-10-01T00:00:00Z')]
			},
			[{ id: 'a' }, { id: 'b' }],
		)
		expect(load).toMatchObject({ status: 'ready', unreadable: 1 })
		expect(load.status === 'ready' && load.rows.map((item) => item.id)).toEqual(['kept'])
	})

	it('fails with one plain sentence when no project can be read', async () => {
		const load = await loadArchived(async () => {
			throw new Error('Error invoking remote method x: boom')
		}, [{ id: 'a' }])
		expect(load.status).toBe('error')
		expect(load.status === 'error' && load.message).not.toMatch(/remote method|Error:/)
	})

	it('has nothing to show without projects', async () => {
		expect(await loadArchived(async () => [], [])).toEqual({
			status: 'ready',
			rows: [],
			unreadable: 0,
		})
	})
})

describe('the Recents section', () => {
	it('shows when either list has something, and always in the archived view', () => {
		expect(archiveSectionVisible({ view: 'recents', recents: 0, archived: 0 })).toBe(false)
		expect(archiveSectionVisible({ view: 'recents', recents: 1, archived: 0 })).toBe(true)
		expect(archiveSectionVisible({ view: 'recents', recents: 0, archived: 2 })).toBe(true)
		expect(archiveSectionVisible({ view: 'archived', recents: 0, archived: 0 })).toBe(true)
	})

	it('names the heading and the button for the view it is in', () => {
		expect(archiveHeading('recents')).toBe('Recents')
		expect(archiveHeading('archived')).toBe('Archived')
		expect(archiveToggleLabel('recents')).toBe('Show archived conversations')
		expect(archiveToggleLabel('archived')).toBe('Back to recents')
		expect(nextArchiveView('recents')).toBe('archived')
		expect(nextArchiveView('archived')).toBe('recents')
	})

	it('says why a list is empty, and says nothing while it is loading or has rows', () => {
		const ready = (n: number): ArchiveLoad => ({
			status: 'ready',
			rows: Array.from({ length: n }, (_, i) => row(`r${i}`, 'p', '2026-10-01T00:00:00Z')),
			unreadable: 0,
		})
		expect(archiveEmptyText({ view: 'archived', load: ready(0), recents: 3 })).toBe(
			'Nothing is archived.',
		)
		expect(archiveEmptyText({ view: 'archived', load: ready(1), recents: 0 })).toBe('')
		expect(archiveEmptyText({ view: 'archived', load: { status: 'loading' }, recents: 0 })).toBe('')
		expect(archiveEmptyText({ view: 'recents', load: ready(2), recents: 0 })).toBe(
			'No recent conversations.',
		)
		expect(archiveEmptyText({ view: 'recents', load: ready(2), recents: 1 })).toBe('')
	})
})
