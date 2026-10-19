/**
 * The entry-file path is built by concatenation so a static file tracer does
 * not read `resolve(dir, `${name}.ext`)` as a wildcard over the repository
 * (#593). These tests pin that the paths on disk are exactly what
 * `path.resolve` produced before.
 */

import { access, mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { DiskMemoryStore } from '../disk.js'
import { MarkdownMemoryStore } from '../markdown.js'
import { entryPath } from '../naming.js'

const roots: string[] = []
afterEach(async () => removeTempDirs(roots.splice(0)))

describe('entryPath', () => {
	it('resolves to the same path as path.resolve(dir, stem + extension)', () => {
		const dir = resolve(tmpdir(), 'namzu-entry-path')
		expect(resolve(entryPath(dir, 'mem_abc123', '.json'))).toBe(resolve(dir, 'mem_abc123.json'))
		expect(resolve(entryPath(dir, 'some-note', '.md'))).toBe(join(dir, 'some-note.md'))
		expect(resolve(entryPath(sep, 'some-note', '.md'))).toBe(resolve(sep, 'some-note.md'))
	})
})

describe('memory stores write entries at the same paths as before', () => {
	it('DiskMemoryStore keeps content at <baseDir>/memory/content/<id>.json', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-entry-paths-'))
		roots.push(root)
		const store = new DiskMemoryStore({ baseDir: root })
		const { entry } = await store.create({ title: 't', summary: 's', content: 'c' })
		const contentDir = join(root, 'memory', 'content')
		expect(await readdir(contentDir)).toEqual([`${entry.id}.json`])
		await access(resolve(contentDir, `${entry.id}.json`))
	})

	it('MarkdownMemoryStore keeps a memory at <directory>/<name>.md', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-entry-paths-'))
		roots.push(root)
		const directory = join(root, 'memory')
		const store = new MarkdownMemoryStore({ directory })
		const { entry } = await store.create({ title: 'Pinned path', summary: 's', content: 'c' })
		expect(entry.name).toBe('pinned-path')
		expect(await readdir(directory)).toContain('pinned-path.md')
		await access(resolve(directory, 'pinned-path.md'))
	})
})
