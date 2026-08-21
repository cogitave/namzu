/**
 * The CLI builds separate store instances for its parent and delegates, all
 * over one path. `save_memory` is declared concurrency-safe, so those stores
 * must not each publish a stale private index and report success.
 */

import { chmod, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { DiskMemoryStore } from '../disk.js'

const roots: string[] = []

afterEach(async () => {
	await removeTempDirs(roots.splice(0))
})

async function root(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), 'namzu-memory-coordinate-'))
	roots.push(path)
	return path
}

describe('DiskMemoryStore same-process coordination', () => {
	it('retains every concurrent create from warmed stores over one path', async () => {
		const baseDir = await root()
		const stores = Array.from({ length: 8 }, () => new DiskMemoryStore({ baseDir }))
		await Promise.all(stores.map((store) => store.list()))

		const created = await Promise.all(
			stores.map((store, index) =>
				store.create({
					title: `memory ${index}`,
					summary: `summary ${index}`,
					content: `content ${index}`,
				}),
			),
		)

		const fresh = new DiskMemoryStore({ baseDir })
		const durable = await fresh.list()
		expect(durable.totalCount).toBe(8)
		expect(new Set(durable.entries.map((entry) => entry.id))).toEqual(
			new Set(created.map(({ entry }) => entry.id)),
		)
		for (const { entry, content } of created) {
			await expect(fresh.get(entry.id)).resolves.toMatchObject({ content: content.content })
		}
	})

	it('refreshes a warmed reader after a sibling store publishes', async () => {
		const baseDir = await root()
		const reader = new DiskMemoryStore({ baseDir })
		const writer = new DiskMemoryStore({ baseDir })
		await expect(reader.list()).resolves.toMatchObject({ totalCount: 0 })

		await writer.create({ title: 'sibling', summary: 'published later', content: 'durable' })

		await expect(reader.list()).resolves.toMatchObject({
			totalCount: 1,
			entries: [expect.objectContaining({ title: 'sibling' })],
		})
	})

	it.skipIf(process.platform === 'win32')(
		'does not publish an index or live entry when create content cannot be written',
		async () => {
			const baseDir = await root()
			const store = new DiskMemoryStore({ baseDir })
			await store.list()
			const contentDir = join(baseDir, 'memory', 'content')
			const indexPath = join(baseDir, 'memory', 'index.json')

			await chmod(contentDir, 0o555)
			try {
				await expect(
					store.create({ title: 'blocked', summary: 'blocked', content: 'blocked' }),
				).rejects.toThrow()
			} finally {
				await chmod(contentDir, 0o755)
			}

			await expect(readFile(indexPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
			expect(await readdir(contentDir)).toEqual([])
			expect((await store.list()).totalCount).toBe(0)
		},
	)

	it.skipIf(process.platform === 'win32')(
		'keeps create out of the live projection when index publication fails',
		async () => {
			const baseDir = await root()
			const store = new DiskMemoryStore({ baseDir })
			await store.list()
			const memoryDir = join(baseDir, 'memory')
			const contentDir = join(memoryDir, 'content')
			const indexPath = join(memoryDir, 'index.json')

			await chmod(memoryDir, 0o555)
			try {
				await expect(
					store.create({ title: 'blocked', summary: 'blocked', content: 'written first' }),
				).rejects.toThrow()
			} finally {
				await chmod(memoryDir, 0o755)
			}

			expect(store.getIndex().count()).toBe(0)
			await expect(readFile(indexPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
			expect(await readdir(contentDir)).toEqual([])
		},
	)

	it.skipIf(process.platform === 'win32')(
		'does not publish index or live metadata when an update content write fails',
		async () => {
			const baseDir = await root()
			const store = new DiskMemoryStore({ baseDir })
			const { entry } = await store.create({
				title: 'original',
				summary: 'original',
				content: 'original',
			})
			const memoryDir = join(baseDir, 'memory')
			const contentDir = join(memoryDir, 'content')
			const indexPath = join(memoryDir, 'index.json')
			const contentPath = join(contentDir, `${entry.id}.json`)
			const indexBytes = await readFile(indexPath, 'utf-8')
			const contentBytes = await readFile(contentPath, 'utf-8')

			await chmod(contentDir, 0o555)
			try {
				await expect(
					store.update(entry.id, { title: 'must not publish', content: 'must not publish' }),
				).rejects.toThrow()
			} finally {
				await chmod(contentDir, 0o755)
			}

			expect(await readFile(indexPath, 'utf-8')).toBe(indexBytes)
			expect(await readFile(contentPath, 'utf-8')).toBe(contentBytes)
			expect((await store.list()).entries[0]?.title).toBe('original')
		},
	)

	it.skipIf(process.platform === 'win32')(
		'keeps an update out of the live projection when index publication fails',
		async () => {
			const baseDir = await root()
			const store = new DiskMemoryStore({ baseDir })
			const { entry } = await store.create({
				title: 'original',
				summary: 'original',
				content: 'original',
			})
			const memoryDir = join(baseDir, 'memory')
			const indexPath = join(memoryDir, 'index.json')
			const indexBytes = await readFile(indexPath, 'utf-8')

			await chmod(memoryDir, 0o555)
			try {
				await expect(
					store.update(entry.id, { title: 'must not become live', content: 'valid newer body' }),
				).rejects.toThrow()
			} finally {
				await chmod(memoryDir, 0o755)
			}

			expect(store.getIndex().getEntry(entry.id)?.title).toBe('original')
			expect(await readFile(indexPath, 'utf-8')).toBe(indexBytes)
			await expect(store.get(entry.id)).resolves.toMatchObject({ content: 'valid newer body' })
		},
	)

	it.skipIf(process.platform === 'win32')(
		'refuses a deletion whose content cannot be removed and permits an exact retry',
		async () => {
			const baseDir = await root()
			const store = new DiskMemoryStore({ baseDir })
			const { entry } = await store.create({
				title: 'sensitive',
				summary: 'must not become an orphan',
				content: 'sensitive bytes',
			})
			const memoryDir = join(baseDir, 'memory')
			const contentDir = join(memoryDir, 'content')
			const indexPath = join(memoryDir, 'index.json')
			const contentPath = join(contentDir, `${entry.id}.json`)
			const indexBytes = await readFile(indexPath, 'utf-8')
			const contentBytes = await readFile(contentPath, 'utf-8')

			await chmod(contentDir, 0o555)
			try {
				await expect(store.delete(entry.id)).rejects.toThrow()
			} finally {
				await chmod(contentDir, 0o755)
			}

			expect(await readFile(indexPath, 'utf-8')).toBe(indexBytes)
			expect(await readFile(contentPath, 'utf-8')).toBe(contentBytes)
			expect((await store.list()).totalCount).toBe(1)

			await expect(store.delete(entry.id)).resolves.toBe(true)
			expect((await store.list()).totalCount).toBe(0)
			await expect(readFile(contentPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
		},
	)

	it.skipIf(process.platform === 'win32')(
		'keeps a failed index deletion visible and lets retry finish it',
		async () => {
			const baseDir = await root()
			const store = new DiskMemoryStore({ baseDir })
			const { entry } = await store.create({
				title: 'indexed',
				summary: 'content removal can commit first',
				content: 'removed before the failed index write',
			})
			const memoryDir = join(baseDir, 'memory')
			const contentPath = join(memoryDir, 'content', `${entry.id}.json`)
			const indexPath = join(memoryDir, 'index.json')
			const indexBytes = await readFile(indexPath, 'utf-8')

			await chmod(memoryDir, 0o555)
			try {
				await expect(store.delete(entry.id)).rejects.toThrow()
			} finally {
				await chmod(memoryDir, 0o755)
			}

			expect(store.getIndex().getEntry(entry.id)?.id).toBe(entry.id)
			expect(await readFile(indexPath, 'utf-8')).toBe(indexBytes)
			await expect(readFile(contentPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })

			await expect(store.delete(entry.id)).resolves.toBe(true)
			expect((await store.list()).totalCount).toBe(0)
		},
	)
})
