import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { DiskRecordStore } from '../../kv/record-store.js'
import { DiskMemoryStore } from '../disk.js'

const roots: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	await removeTempDirs(roots.splice(0))
})

it('reads only the selected disk bodies and gives an honest continuation for an older match', async () => {
	const baseDir = await mkdtemp(join(tmpdir(), 'namzu-bounded-memory-search-'))
	roots.push(baseDir)
	const store = new DiskMemoryStore({ baseDir })
	let time = 1_000
	const clock = vi.spyOn(Date, 'now').mockImplementation(() => ++time)
	try {
		await store.create({ title: 'Oldest', summary: '', content: 'only the oldest has ambermarker' })
		for (const title of ['Second', 'Third', 'Newest']) {
			await store.create({ title, summary: '', content: 'other fact' })
		}
	} finally {
		clock.mockRestore()
	}

	const reads = vi.spyOn(DiskRecordStore.prototype, 'read')
	const first = await store.list({ query: 'ambermarker', maxScanned: 2, limit: 1 })
	expect(first).toMatchObject({
		entries: [],
		totalCount: 0,
		truncated: true,
		scannedCount: 2,
		nextScanOffset: 2,
	})
	expect(
		reads.mock.calls.filter(([path]) => String(path).includes(`${sep}content${sep}`)),
	).toHaveLength(2)

	reads.mockClear()
	const second = await store.list({
		query: 'ambermarker',
		maxScanned: 2,
		scanOffset: first.nextScanOffset,
		limit: 1,
	})
	expect(second.entries.map((entry) => entry.title)).toEqual(['Oldest'])
	expect(second).toMatchObject({ totalCount: 1, truncated: false, scannedCount: 2 })
	expect(second.nextScanOffset).toBeUndefined()
	expect(
		reads.mock.calls.filter(([path]) => String(path).includes(`${sep}content${sep}`)),
	).toHaveLength(2)
})

it('refuses an invalid scan budget before reading disk content', async () => {
	const baseDir = await mkdtemp(join(tmpdir(), 'namzu-bounded-memory-search-'))
	roots.push(baseDir)
	const store = new DiskMemoryStore({ baseDir })
	await store.create({ title: 'Record', summary: '', content: 'content' })
	const reads = vi.spyOn(DiskRecordStore.prototype, 'read')
	await expect(store.list({ query: 'content', maxScanned: 0 })).rejects.toThrow(
		'maxScanned must be a positive safe integer',
	)
	expect(
		reads.mock.calls.filter(([path]) => String(path).includes(`${sep}content${sep}`)),
	).toHaveLength(0)
})
