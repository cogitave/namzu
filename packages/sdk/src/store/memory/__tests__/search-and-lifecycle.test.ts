import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import type { MemoryStore } from '../../../types/memory/index.js'
import { DiskMemoryStore } from '../disk.js'
import { InMemoryMemoryStore } from '../memory.js'

const roots: string[] = []
afterEach(async () => removeTempDirs(roots.splice(0)))

async function fixture(kind: 'disk' | 'memory'): Promise<MemoryStore> {
	if (kind === 'memory') return new InMemoryMemoryStore()
	const baseDir = await mkdtemp(join(tmpdir(), 'namzu-memory-search-lifecycle-'))
	roots.push(baseDir)
	return new DiskMemoryStore({ baseDir })
}

describe.each(['disk', 'memory'] as const)('%s memory search and lifecycle', (kind) => {
	it('rechecks archived state and changed body together after an earlier search', async () => {
		const store = await fixture(kind)
		const created = await store.create({
			title: 'Old routing advice',
			summary: '',
			content: 'old endpoint',
			tags: ['route'],
			metadata: { source: { revision: 1 } },
		})
		const selected = await store.list({ query: 'endpoint', status: 'active' })
		expect(selected.entries[0]?.id).toBe(created.entry.id)
		await store.update(created.entry.id, {
			title: 'Superseded routing advice',
			status: 'archived',
			content: 'new endpoint',
			metadata: { source: { revision: 2 } },
		})
		const current = await store.getRecord?.(created.entry.id)
		expect(current).toMatchObject({
			entry: { id: created.entry.id, title: 'Superseded routing advice', status: 'archived' },
			content: {
				id: created.entry.id,
				content: 'new endpoint',
				metadata: { source: { revision: 2 } },
			},
		})
		// A caller cannot change a later snapshot by mutating this one.
		;(current!.entry.tags as string[]).push('external mutation')
		;(current!.content.metadata!.source as { revision: number }).revision = 999
		expect((await store.getRecord?.(created.entry.id))?.entry.tags).toEqual(['route'])
		expect((await store.getRecord?.(created.entry.id))?.content.metadata).toEqual({
			source: { revision: 2 },
		})
		await store.delete(created.entry.id)
		expect(await store.getRecord?.(created.entry.id)).toBeUndefined()
	})

	it('finds a learned fact in its body with a multiword query in another order', async () => {
		const store = await fixture(kind)
		const { entry } = await store.create({
			title: 'Inspect service configuration',
			summary: 'discoveries (1)',
			content: 'The cerulean-cache expires after 14 hours.',
		})
		const result = await store.list({ query: 'expiry cerulean cache', limit: 1 })
		expect(result.entries.map((candidate) => candidate.id)).toEqual([entry.id])
		expect(result.totalCount).toBe(1)
		expect(result.entries[0]).not.toHaveProperty('content')
	})

	it('ranks query coverage before field weight and does not reward repeating one word', async () => {
		const store = await fixture(kind)
		const complete = await store.create({
			title: 'Older fact',
			summary: '',
			content: 'cache expiry policy',
		})
		const titleMatch = await store.create({ title: 'cache', summary: '', content: '' })
		const noisy = await store.create({
			title: 'Newest fact',
			summary: '',
			content: 'cache '.repeat(500),
		})
		const result = await store.list({ query: 'expiry cache', limit: 2 })
		expect(result.totalCount).toBe(3)
		expect(result.entries.map((entry) => entry.id)).toEqual([
			complete.entry.id,
			titleMatch.entry.id,
		])
		expect(result.entries.some((entry) => entry.id === noisy.entry.id)).toBe(false)
	})

	it('normalizes Unicode terms without treating an empty substring as a match', async () => {
		const store = await fixture(kind)
		const { entry } = await store.create({
			title: 'Test',
			summary: '',
			content: 'ÖNBELLEK süresi; ＣＡＣＨＥ',
		})
		expect((await store.list({ query: 'önbellek cache' })).entries[0]?.id).toBe(entry.id)
		expect((await store.list({ query: 'cache-unknown' })).totalCount).toBe(1)
		expect((await store.list({ query: 'unrelated' })).totalCount).toBe(0)
		expect((await store.list({ query: '?!' })).totalCount).toBe(0)
	})

	it('archives/reactivates explicitly and keeps filters, update and deletion coherent', async () => {
		const store = await fixture(kind)
		const { entry } = await store.create({
			title: 'Database',
			summary: '',
			content: 'port 5432',
			tags: ['service', 'ops'],
		})
		await store.update(entry.id, { status: 'archived', content: 'port 6432' })
		expect((await store.list({ query: '6432', status: 'active' })).totalCount).toBe(0)
		expect(
			(await store.list({ query: '6432', status: 'archived', tags: ['service', 'ops'] })).entries[0]
				?.id,
		).toBe(entry.id)
		expect((await store.list({ query: '6432', tags: ['service', 'absent'] })).totalCount).toBe(0)
		expect((await store.list({ query: '5432' })).totalCount).toBe(0)
		await store.update(entry.id, { status: 'active' })
		expect((await store.list({ query: '6432', status: 'active' })).totalCount).toBe(1)
		await expect(store.update(entry.id, { status: 'invalid' as never })).rejects.toThrow(
			'Unknown MemoryStatus',
		)
		expect((await store.list({ query: '6432', status: 'active' })).totalCount).toBe(1)
		expect(await store.delete(entry.id)).toBe(true)
		expect((await store.list({ query: '6432' })).totalCount).toBe(0)
	})
})

it('searches a sibling process/store update rather than retaining a cached body', async () => {
	const baseDir = await mkdtemp(join(tmpdir(), 'namzu-memory-search-refresh-'))
	roots.push(baseDir)
	const writer = new DiskMemoryStore({ baseDir })
	const { entry } = await writer.create({ title: 'Route', summary: '', content: 'old-endpoint' })
	const reader = new DiskMemoryStore({ baseDir })
	expect((await reader.list({ query: 'old' })).totalCount).toBe(1)
	await writer.update(entry.id, { content: 'new-endpoint' })
	expect((await reader.list({ query: 'old' })).totalCount).toBe(0)
	expect((await reader.list({ query: 'new' })).totalCount).toBe(1)
	await writer.update(entry.id, { status: 'archived', content: 'retired-endpoint' })
	expect(await reader.getRecord(entry.id)).toMatchObject({
		entry: { id: entry.id, status: 'archived' },
		content: { id: entry.id, content: 'retired-endpoint' },
	})
})

it.each(['disk', 'memory'] as const)(
	'%s applies exact identifier constraints before limiting, including body-only lookup',
	async (kind) => {
		const store = await fixture(kind)
		await store.create({
			title: 'seconds timeout seconds',
			summary: 'timeout',
			content: 'opal70 uses 19 seconds',
		})
		const { entry } = await store.create({
			title: 'Recorded fact',
			summary: '',
			content: 'quartz9 uses 23 seconds',
		})
		const result = await store.list({
			query: 'seconds timeout',
			requiredIdentifiers: ['ＱＵＡＲＴＺ９'],
			limit: 1,
		})
		expect(result.entries.map((e) => e.id)).toEqual([entry.id])
		expect(result.totalCount).toBe(1)
		expect(
			(await store.list({ requiredIdentifiers: ['quartz9'] })).entries.map((e) => e.id),
		).toEqual([entry.id])
		expect((await store.list({ requiredIdentifiers: ['opal7'] })).totalCount).toBe(0)
		expect((await store.list({ requiredIdentifiers: [] })).totalCount).toBe(2)
		await store.update(entry.id, { content: 'quartz90 uses 24 seconds' })
		expect((await store.list({ requiredIdentifiers: ['quartz9'] })).totalCount).toBe(0)
	},
)
