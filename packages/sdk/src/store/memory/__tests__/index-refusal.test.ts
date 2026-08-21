/**
 * A memory index the store cannot prove valid is not an empty index.
 *
 * Treating either case as empty lets the very next create publish a fresh
 * index over bytes this build did not understand. The structural fixture is
 * valid JSON on purpose: a parse-only check passes it, initialises the store,
 * and persists the poisoned entry beside the new one.
 */

import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { DiskMemoryStore } from '../disk.js'

const roots: string[] = []

afterEach(async () => {
	await removeTempDirs(roots.splice(0))
})

async function fixture(index: unknown): Promise<{
	root: string
	indexPath: string
	contentDir: string
	bytes: string
}> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-memory-index-'))
	roots.push(root)
	const memoryDir = join(root, 'memory')
	const indexPath = join(memoryDir, 'index.json')
	const contentDir = join(memoryDir, 'content')
	const bytes = `${JSON.stringify(index, null, 2)}\n`
	await mkdir(memoryDir, { recursive: true })
	await writeFile(indexPath, bytes)
	return { root, indexPath, contentDir, bytes }
}

const createInput = {
	title: 'must not overwrite',
	summary: 'a refused index stays byte-identical',
	content: 'no content record is published either',
}

const validEntry = {
	id: 'mem_valid',
	title: 'valid title',
	summary: 'valid summary',
	tags: ['valid'],
	status: 'active',
	createdAt: 1,
	updatedAt: 1,
} as const

describe('DiskMemoryStore index admission', () => {
	it.each([
		['non-array top level', { entries: [] }],
		['non-object entry', [null]],
		['non-string id', [{ ...validEntry, id: 1 }]],
		['non-canonical id', [{ ...validEntry, id: 'run_wrong_kind' }]],
		['duplicate id', [validEntry, { ...validEntry, title: 'duplicate' }]],
		['non-string title', [{ ...validEntry, title: null }]],
		['non-string summary', [{ ...validEntry, summary: null }]],
		['non-string tag', [{ ...validEntry, tags: ['valid', 1] }]],
		['unknown status', [{ ...validEntry, status: 'forgotten' }]],
		['non-numeric creation time', [{ ...validEntry, createdAt: 'yesterday' }]],
		['non-numeric update time', [{ ...validEntry, updatedAt: 'today' }]],
		['future index format', { schemaVersion: 999, entries: [] }],
	] as const)(
		'refuses a %s without overwriting it, then retries after repair',
		async (_name, poisoned) => {
			const { root, indexPath, contentDir, bytes } = await fixture(poisoned)
			const store = new DiskMemoryStore({ baseDir: root })

			await expect(store.create(createInput)).rejects.toThrow(/memory|schema|index|version/i)
			expect(await readFile(indexPath, 'utf-8')).toBe(bytes)
			expect(await readdir(contentDir)).toEqual([])

			// Failure is not latched as either success or permanent poison. An
			// operator can repair/restore the durable bytes and retry this same
			// live store without restarting the host.
			await writeFile(indexPath, '[]\n')
			await expect(store.create(createInput)).resolves.toMatchObject({
				entry: { title: createInput.title },
				content: { content: createInput.content },
			})
			expect((await store.list()).totalCount).toBe(1)
		},
	)
})
