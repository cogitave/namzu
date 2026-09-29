import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import type { ConditionalMemoryStore } from '../../../types/memory/index.js'
import { DiskMemoryStore } from '../disk.js'
import { MarkdownMemoryStore } from '../markdown.js'
import { InMemoryMemoryStore } from '../memory.js'
import { MemoryRevisionConflictError } from '../revision.js'

const roots: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	await removeTempDirs(roots.splice(0))
})

async function fixture(kind: 'memory' | 'disk' | 'markdown'): Promise<{
	store: ConditionalMemoryStore
	other: ConditionalMemoryStore
	directory?: string
}> {
	if (kind === 'memory') {
		const store = new InMemoryMemoryStore()
		return { store, other: store }
	}
	const root = await mkdtemp(join(tmpdir(), 'namzu-memory-revision-'))
	roots.push(root)
	if (kind === 'disk') {
		return {
			store: new DiskMemoryStore({ baseDir: root }),
			other: new DiskMemoryStore({ baseDir: root }),
		}
	}
	const directory = join(root, 'memory')
	return {
		store: new MarkdownMemoryStore({ directory }),
		other: new MarkdownMemoryStore({ directory }),
		directory,
	}
}

describe.each(['memory', 'disk', 'markdown'] as const)('%s conditional memory writes', (kind) => {
	it('admits only one of two writers carrying the same revision', async () => {
		const { store, other } = await fixture(kind)
		const { entry } = await store.create({
			title: 'Shared claim',
			summary: 'Claim',
			content: 'Original',
		})
		const revision = (await store.getVersionedRecord(entry.id))?.revision
		if (!revision) throw new Error('Expected a memory revision')
		const outcomes = await Promise.allSettled([
			store.updateIfRevision(entry.id, { content: 'First writer' }, revision),
			other.updateIfRevision(entry.id, { content: 'Second writer' }, revision),
		])
		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
		const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
		expect(rejected).toMatchObject({ reason: expect.any(MemoryRevisionConflictError) })
		const current = await store.getVersionedRecord(entry.id)
		expect(['First writer', 'Second writer']).toContain(current?.content.content)
		expect(current?.revision).not.toBe(revision)
	})

	it('rejects a stale writer and deletion without changing the newer record', async () => {
		// Disk and in-memory stores use Date.now() directly for updatedAt. The
		// digest must still detect a second write in the same millisecond.
		vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
		const { store, other } = await fixture(kind)
		const { entry } = await store.create({
			title: 'Cache policy',
			summary: 'Original summary',
			content: 'Original body',
			metadata: { source: { version: 1 } },
		})
		const stale = await store.getVersionedRecord(entry.id)
		expect(stale?.revision).toMatch(/^m1:[a-f0-9]{64}$/)
		await other.update(entry.id, {
			content: 'New body',
			metadata: { source: { version: 2 } },
		})
		const current = await store.getVersionedRecord(entry.id)
		expect(current?.revision).not.toBe(stale?.revision)
		if (kind !== 'markdown') expect(current?.entry.updatedAt).toBe(stale?.entry.updatedAt)
		if (!stale || !current) throw new Error('Expected both memory snapshots')

		await expect(
			store.updateIfRevision(entry.id, { content: 'Stale correction' }, stale.revision),
		).rejects.toBeInstanceOf(MemoryRevisionConflictError)
		await expect(store.deleteIfRevision(entry.id, stale.revision)).rejects.toBeInstanceOf(
			MemoryRevisionConflictError,
		)
		expect(await other.getVersionedRecord(entry.id)).toEqual(current)

		await store.updateIfRevision(entry.id, { summary: 'Fresh correction' }, current.revision)
		const fresh = await other.getVersionedRecord(entry.id)
		expect(fresh?.entry.summary).toBe('Fresh correction')
		if (!fresh) throw new Error('Expected the updated memory')
		await expect(store.deleteIfRevision(entry.id, current.revision)).rejects.toBeInstanceOf(
			MemoryRevisionConflictError,
		)
		await store.deleteIfRevision(entry.id, fresh.revision)
		expect(await other.getVersionedRecord(entry.id)).toBeUndefined()
		await expect(
			store.updateIfRevision(entry.id, { content: 'Lost' }, fresh.revision),
		).rejects.toBeInstanceOf(MemoryRevisionConflictError)
	})

	it('includes nested metadata while ignoring object key insertion order', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
		const { store } = await fixture(kind)
		const { entry } = await store.create({
			title: 'Metadata',
			summary: 'Metadata',
			content: 'Body',
			metadata: { nested: { a: 1, b: 2 } },
		})
		const initial = await store.getVersionedRecord(entry.id)
		if (!initial) throw new Error('Expected a saved memory')
		await store.updateIfRevision(
			entry.id,
			{ metadata: { nested: { b: 2, a: 1 } } },
			initial.revision,
		)
		const reordered = await store.getVersionedRecord(entry.id)
		if (kind !== 'markdown') expect(reordered?.revision).toBe(initial.revision)
		const revision = reordered?.revision
		if (!revision) throw new Error('Expected a revision')
		await store.update(entry.id, { metadata: { nested: { b: 3, a: 1 } } })
		await expect(store.deleteIfRevision(entry.id, revision)).rejects.toBeInstanceOf(
			MemoryRevisionConflictError,
		)
	})
})

it('refuses a Markdown hand edit even when updatedAt is unchanged', async () => {
	const { store, directory } = await fixture('markdown')
	if (!directory) throw new Error('Expected Markdown directory')
	const { entry } = await store.create({
		title: 'Operator note',
		summary: 'A note',
		content: 'Original body',
	})
	const stale = await store.getVersionedRecord(entry.id)
	if (!stale || !entry.name) throw new Error('Expected a named memory')
	const path = join(directory, `${entry.name}.md`)
	const edited = (await readFile(path, 'utf8')).replace('Original body', 'Hand edited body')
	await writeFile(path, edited)
	const current = await store.getVersionedRecord(entry.id)
	expect(current?.entry.updatedAt).toBe(stale.entry.updatedAt)
	expect(current?.revision).not.toBe(stale.revision)
	await expect(
		store.updateIfRevision(entry.id, { content: 'Overwrite' }, stale.revision),
	).rejects.toBeInstanceOf(MemoryRevisionConflictError)
	await expect(store.deleteIfRevision(entry.id, stale.revision)).rejects.toBeInstanceOf(
		MemoryRevisionConflictError,
	)
	expect(await readFile(path, 'utf8')).toBe(edited)
})
