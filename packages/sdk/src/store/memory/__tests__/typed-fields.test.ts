import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import type { MemoryStore } from '../../../types/memory/index.js'
import { DiskMemoryStore } from '../disk.js'
import { MarkdownMemoryStore } from '../markdown.js'
import { InMemoryMemoryStore } from '../memory.js'
import { MemoryNameConflictError, slugifyMemoryName } from '../naming.js'

const roots: string[] = []
afterEach(async () => removeTempDirs(roots.splice(0)))

async function tempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-typed-memory-'))
	roots.push(root)
	return root
}

const stores: [string, () => Promise<MemoryStore>][] = [
	['InMemoryMemoryStore', async () => new InMemoryMemoryStore()],
	['DiskMemoryStore', async () => new DiskMemoryStore({ baseDir: await tempRoot() })],
	['MarkdownMemoryStore', async () => new MarkdownMemoryStore({ directory: await tempRoot() })],
]

describe.each(stores)('%s carries the optional typed fields', (_label, make) => {
	it('persists name, description and type through create and update', async () => {
		const store = await make()
		const { entry } = await store.create({
			title: 'Deploy window',
			summary: 'Deploys go out on Tuesdays.',
			content: 'c',
			name: 'deploy-window',
			description: 'When deploys are allowed',
			type: 'project',
		})
		expect(entry).toMatchObject({
			name: 'deploy-window',
			description: 'When deploys are allowed',
			type: 'project',
		})
		const updated = await store.update(entry.id, {
			type: 'reference',
			description: 'Deploy calendar',
		})
		expect(updated).toMatchObject({
			name: 'deploy-window',
			type: 'reference',
			description: 'Deploy calendar',
		})
		expect((await store.getRecord?.(entry.id))?.entry).toMatchObject({
			type: 'reference',
		})
	})

	it('refuses a name another record holds, and a malformed field', async () => {
		const store = await make()
		const { entry } = await store.create({
			title: 't',
			summary: 's',
			content: 'c',
			name: 'taken',
		})
		await expect(
			store.create({ title: 't', summary: 's', content: 'c', name: 'taken' }),
		).rejects.toBeInstanceOf(MemoryNameConflictError)
		const other = await store.create({
			title: 'u',
			summary: 's',
			content: 'c',
			name: 'other',
		})
		await expect(store.update(other.entry.id, { name: 'taken' })).rejects.toMatchObject({
			existingId: entry.id,
		})
		await expect(
			store.create({
				title: 't',
				summary: 's',
				content: 'c',
				type: 'opinion' as never,
			}),
		).rejects.toMatchObject({ code: 'invalid_config' })
		await expect(
			store.create({
				title: 't',
				summary: 's',
				content: 'c',
				description: 'two\nlines',
			}),
		).rejects.toMatchObject({ code: 'invalid_config' })
	})

	it('ranks a match in the description like one in the summary', async () => {
		const store = await make()
		await store.create({
			title: 'a',
			summary: 's',
			content: 'c',
			description: 'zircon settings',
		})
		const result = await store.list({ query: 'zircon' })
		expect(result.totalCount).toBe(1)
	})
})

describe('DiskMemoryStore index validation for the typed fields', () => {
	it('refuses an index whose optional name is malformed', async () => {
		const baseDir = await tempRoot()
		const store = new DiskMemoryStore({ baseDir })
		const { entry } = await store.create({
			title: 't',
			summary: 's',
			content: 'c',
			name: 'fine',
		})
		const indexPath = join(baseDir, 'memory', 'index.json')
		const index = JSON.parse(await readFile(indexPath, 'utf8'))
		index[0].name = '../escape'
		await writeFile(indexPath, JSON.stringify(index))
		await expect(store.get(entry.id)).rejects.toThrow('name must be a kebab-case memory name')
	})

	it('reads an index written before typed fields existed', async () => {
		const baseDir = await tempRoot()
		const store = new DiskMemoryStore({ baseDir })
		const { entry } = await store.create({
			title: 't',
			summary: 's',
			content: 'c',
		})
		expect(entry.name).toBeUndefined()
		expect(entry.type).toBeUndefined()
		expect((await store.list()).entries[0]).toEqual(entry)
	})

	it('does not leak the file version stamp into MemoryContent', async () => {
		const store = new DiskMemoryStore({ baseDir: await tempRoot() })
		const { entry } = await store.create({
			title: 't',
			summary: 's',
			content: 'c',
		})
		expect(Object.keys((await store.get(entry.id)) ?? {})).not.toContain('schemaVersion')
	})
})

describe('slugifyMemoryName', () => {
	it.each([
		['Tests need a built SDK', 'tests-need-a-built-sdk'],
		['Çalışma dizini ayarı', 'calisma-dizini-ayari'],
		['日本語', 'memory-note'],
		['MEMORY', 'memory-note'],
		['x'.repeat(100), 'x'.repeat(32)],
		['Always run pnpm -r build before running the CLI tests', 'always-run-pnpm-r-build-before'],
	])('%s → %s', (title, slug) => {
		expect(slugifyMemoryName(title)).toBe(slug)
	})
})
