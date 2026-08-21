/**
 * An index entry is a promise that its content exists and has the shape the
 * public `MemoryStore` returns. A cast cannot establish either fact.
 */

import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import type { MemoryId } from '../../../types/ids/index.js'
import { DiskMemoryStore } from '../disk.js'

const roots: string[] = []

afterEach(async () => {
	await removeTempDirs(roots.splice(0))
})

async function capture(path: string): Promise<string | null> {
	try {
		return await readFile(path, 'utf-8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw error
	}
}

async function fixture(): Promise<{
	store: DiskMemoryStore
	id: MemoryId
	indexPath: string
	contentPath: string
	indexBytes: string
	contentBytes: string
}> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-memory-content-'))
	roots.push(root)
	const store = new DiskMemoryStore({ baseDir: root })
	const created = await store.create({
		title: 'original title',
		summary: 'original summary',
		content: 'original content',
		metadata: { source: 'fixture' },
	})
	const indexPath = join(root, 'memory', 'index.json')
	const contentPath = join(root, 'memory', 'content', `${created.entry.id}.json`)
	return {
		store,
		id: created.entry.id,
		indexPath,
		contentPath,
		indexBytes: await readFile(indexPath, 'utf-8'),
		contentBytes: await readFile(contentPath, 'utf-8'),
	}
}

type Poison = (path: string, id: MemoryId) => Promise<string | null>

const poisons: ReadonlyArray<readonly [string, Poison]> = [
	[
		'missing content',
		async (path) => {
			await unlink(path)
			return null
		},
	],
	[
		'invalid JSON',
		async (path) => {
			const bytes = '{\n'
			await writeFile(path, bytes)
			return bytes
		},
	],
	[
		'a future content schema',
		async (path, id) => {
			const bytes = `${JSON.stringify({ id, content: 'future', format: 'text', schemaVersion: 999 })}\n`
			await writeFile(path, bytes)
			return bytes
		},
	],
	[
		'a non-object content record',
		async (path) => {
			const bytes = 'null\n'
			await writeFile(path, bytes)
			return bytes
		},
	],
	[
		'a mismatched content ID',
		async (path) => {
			const bytes = `${JSON.stringify({ id: 'mem_other', content: 'wrong owner', format: 'text' })}\n`
			await writeFile(path, bytes)
			return bytes
		},
	],
	[
		'a non-string content body',
		async (path, id) => {
			const bytes = `${JSON.stringify({ id, content: null, format: 'text' })}\n`
			await writeFile(path, bytes)
			return bytes
		},
	],
	[
		'an unknown content format',
		async (path, id) => {
			const bytes = `${JSON.stringify({ id, content: 'body', format: 'binary' })}\n`
			await writeFile(path, bytes)
			return bytes
		},
	],
	[
		'an array metadata value',
		async (path, id) => {
			const bytes = `${JSON.stringify({ id, content: 'body', format: 'text', metadata: [] })}\n`
			await writeFile(path, bytes)
			return bytes
		},
	],
]

describe('DiskMemoryStore content integrity', () => {
	it.each(poisons)(
		'refuses %s without publishing an update, then retries',
		async (_name, poison) => {
			const { store, id, indexPath, contentPath, indexBytes, contentBytes } = await fixture()
			const poisonedBytes = await poison(contentPath, id)

			await expect(store.get(id)).rejects.toThrow()
			await expect(
				store.update(id, { title: 'must not publish', content: 'must not repair implicitly' }),
			).rejects.toThrow()

			expect(await readFile(indexPath, 'utf-8')).toBe(indexBytes)
			expect(await capture(contentPath)).toBe(poisonedBytes)
			expect((await store.list()).entries[0]?.title).toBe('original title')

			await writeFile(contentPath, contentBytes)
			await expect(store.get(id)).resolves.toMatchObject({
				id,
				content: 'original content',
			})
			await expect(
				store.update(id, { title: 'repaired title', content: 'repaired content' }),
			).resolves.toMatchObject({ id, title: 'repaired title' })
			await expect(store.get(id)).resolves.toMatchObject({ content: 'repaired content' })
		},
	)

	it('returns undefined only when the index has no such memory', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-memory-content-'))
		roots.push(root)
		await mkdir(join(root, 'memory'), { recursive: true })
		const store = new DiskMemoryStore({ baseDir: root })

		await expect(store.get('mem_unknown' as MemoryId)).resolves.toBeUndefined()
	})
})
