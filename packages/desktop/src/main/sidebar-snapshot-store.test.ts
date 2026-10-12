import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readSidebarSnapshot } from '../shared/sidebar-snapshot.js'
import { SidebarSnapshotStore } from './sidebar-snapshot-store.js'

let directory = ''
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'namzu-sidebar-snapshot-'))
	vi.useFakeTimers()
})
afterEach(async () => {
	vi.useRealTimers()
	await rm(directory, { recursive: true, force: true })
})

const picture = {
	v: 1,
	pals: [
		{
			id: 'pal-1',
			name: 'Kiro',
			appearance: { character: 'pixel', color: 'green' },
			paused: false,
		},
	],
	conversations: [
		{
			id: 'c1',
			projectId: 'p1',
			title: 'First',
			updatedAt: '2026-10-01T00:00:00.000Z',
			pinned: true,
		},
	],
	expandedProjects: ['p1'],
	archivedCount: 2,
}

it('writes a burst of changes once, after the delay, and reads it back on the next start', async () => {
	const file = join(directory, 'sidebar-snapshot.json')
	const store = new SidebarSnapshotStore(file, { delayMs: 100 })
	expect(store.get()).toBeUndefined()
	expect(store.set({ ...picture, expandedProjects: [] })).toBe(true)
	expect(store.set(picture)).toBe(true)
	await expect(readFile(file, 'utf8')).rejects.toThrow()
	await vi.advanceTimersByTimeAsync(100)
	expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(picture)
	expect(new SidebarSnapshotStore(file).get()).toEqual(picture)
})

it('writes what is waiting when it is flushed on the way out', async () => {
	const file = join(directory, 'sidebar-snapshot.json')
	const store = new SidebarSnapshotStore(file, { delayMs: 10_000 })
	store.set(picture)
	store.flush()
	expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(picture)
})

it('reads a missing or damaged file as no snapshot, and refuses what is not one', async () => {
	const file = join(directory, 'sidebar-snapshot.json')
	await writeFile(file, '{not json')
	const store = new SidebarSnapshotStore(file)
	expect(store.get()).toBeUndefined()
	expect(store.set({ v: 2 })).toBe(false)
	expect(store.set('nope')).toBe(false)
})

it('keeps only well-formed rows and bounded lists', () => {
	const read = readSidebarSnapshot({
		v: 1,
		pals: [
			{ id: 'a', name: 'A', paused: false, appearance: { character: 'x', color: 'green' } },
			{ name: 'no id' },
		],
		conversations: [
			{ id: 'c1', projectId: 'p', title: '', updatedAt: 'x', secret: 'message text' },
			{ id: 'c1', projectId: 'p', title: 'dup', updatedAt: 'x' },
			{ id: 'c2', title: 'no project', updatedAt: 'x' },
		],
		expandedProjects: ['p', 'p', 7],
		archivedCount: -1,
	})
	expect(read).toEqual({
		v: 1,
		pals: [{ id: 'a', name: 'A', paused: false }],
		conversations: [{ id: 'c1', projectId: 'p', title: '', updatedAt: 'x' }],
		expandedProjects: ['p'],
	})
})
