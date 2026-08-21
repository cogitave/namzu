/**
 * Branded IDs are not filesystem authority. `asMemoryId` intentionally checks
 * only the type prefix, while this store turns the value into a filename.
 */

import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import type { MemoryId } from '../../../types/ids/index.js'
import { DiskMemoryStore } from '../disk.js'

const roots: string[] = []
const escapedId = 'mem_/../../../outside-secret' as MemoryId

afterEach(async () => {
	await removeTempDirs(roots.splice(0))
})

async function fixture(): Promise<{
	store: DiskMemoryStore
	indexPath: string
	outsidePath: string
	indexBytes: string
	outsideBytes: string
}> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-memory-key-'))
	roots.push(root)
	const memoryDir = join(root, 'memory')
	const contentDir = join(memoryDir, 'content')
	const indexPath = join(memoryDir, 'index.json')
	const outsidePath = join(contentDir, `${escapedId}.json`)
	const indexBytes = `${JSON.stringify(
		[
			{
				id: escapedId,
				title: 'crafted index',
				summary: 'must not grant path authority',
				tags: [],
				status: 'active',
				createdAt: 1,
				updatedAt: 1,
			},
		],
		null,
		2,
	)}\n`
	const outsideBytes = `${JSON.stringify(
		{ id: escapedId, content: 'outside secret bytes', format: 'text', schemaVersion: 1 },
		null,
		2,
	)}\n`
	await mkdir(contentDir, { recursive: true })
	await writeFile(indexPath, indexBytes)
	await writeFile(outsidePath, outsideBytes)
	return {
		store: new DiskMemoryStore({ baseDir: root }),
		indexPath,
		outsidePath,
		indexBytes,
		outsideBytes,
	}
}

describe('DiskMemoryStore storage-key containment', () => {
	it.each([
		['read', (store: DiskMemoryStore) => store.get(escapedId)],
		[
			'update',
			(store: DiskMemoryStore) =>
				store.update(escapedId, { title: 'overwrite', content: 'overwrite' }),
		],
		['delete', (store: DiskMemoryStore) => store.delete(escapedId)],
	] as const)(
		'refuses an escaping ID before %s can touch the escaped target',
		async (_name, act) => {
			const { store, indexPath, outsidePath, indexBytes, outsideBytes } = await fixture()

			await expect(act(store)).rejects.toThrow(/memory|id|index|storage/i)
			expect(await readFile(indexPath, 'utf-8')).toBe(indexBytes)
			expect(await readFile(outsidePath, 'utf-8')).toBe(outsideBytes)
		},
	)

	it.each(['mem_\\..\\outside', 'mem_safe:stream', 'mem_safe.name'])(
		'refuses the cross-platform unsafe segment %s at index admission',
		async (id) => {
			const root = await mkdtemp(join(tmpdir(), 'namzu-memory-key-'))
			roots.push(root)
			const memoryDir = join(root, 'memory')
			const indexPath = join(memoryDir, 'index.json')
			const bytes = `${JSON.stringify([
				{
					id,
					title: 'unsafe',
					summary: 'unsafe',
					tags: [],
					status: 'active',
					createdAt: 1,
					updatedAt: 1,
				},
			])}\n`
			await mkdir(memoryDir, { recursive: true })
			await writeFile(indexPath, bytes)

			const store = new DiskMemoryStore({ baseDir: root })
			await expect(store.list()).rejects.toThrow(/memory|id|index|storage/i)
			expect(await readFile(indexPath, 'utf-8')).toBe(bytes)
		},
	)

	it.skipIf(process.platform === 'win32')(
		'refuses a content directory that resolves outside the memory root',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'namzu-memory-key-'))
			roots.push(root)
			const memoryDir = join(root, 'memory')
			const outsideDir = join(root, 'outside-content')
			await mkdir(memoryDir, { recursive: true })
			await mkdir(outsideDir, { recursive: true })
			await symlink(outsideDir, join(memoryDir, 'content'), 'dir')

			const store = new DiskMemoryStore({ baseDir: root })
			await expect(store.list()).rejects.toThrow(/content|memory|outside/i)
			expect(await readdir(outsideDir)).toEqual([])
		},
	)
})
