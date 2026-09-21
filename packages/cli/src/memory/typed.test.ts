import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DiskMemoryStore, MarkdownMemoryStore } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import {
	composeStoredMemoryPrompt,
	migrateMemoryOnce,
	saveTypedNote,
	splitCuratedBullets,
} from './typed.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), 'namzu-typed-cli-'))
	roots.push(root)
	return root
}

describe('splitCuratedBullets', () => {
	it('takes single-line top-level bullets and leaves prose, headings and multi-line notes', () => {
		const text = [
			'# Notes',
			'',
			'Some prose.',
			'- one',
			'- two',
			'- multi-line note',
			'its unindented second line',
			'- parent',
			'  - nested',
			'',
		].join('\n')
		const { bullets, rest } = splitCuratedBullets(text)
		expect(bullets).toEqual(['one', 'two'])
		expect(rest).toBe(
			'# Notes\n\nSome prose.\n- multi-line note\nits unindented second line\n- parent\n  - nested\n',
		)
	})

	it('leaves nothing when the file held only bullets', () => {
		expect(splitCuratedBullets('- a\n- b\n')).toEqual({ bullets: ['a', 'b'], rest: '' })
	})
})

describe('saveTypedNote', () => {
	it('defaults to project, honours a type, and does not save the same text twice', async () => {
		const store = new MarkdownMemoryStore({ directory: tempRoot() })
		const first = await saveTypedNote(store, '  Deploys need a changeset  ')
		expect(first).toMatchObject({ saved: true, type: 'project', name: 'deploys-need-a-changeset' })
		expect(readFileSync(first.path ?? '', 'utf8')).toContain('\ntype: project\n')
		expect(await saveTypedNote(store, 'Deploys need a changeset')).toMatchObject({
			saved: false,
			duplicate: true,
			name: 'deploys-need-a-changeset',
		})
		expect(await saveTypedNote(store, 'Answer tersely', 'feedback')).toMatchObject({
			type: 'feedback',
		})
		expect(await saveTypedNote(store, '   ')).toEqual({ saved: false, type: 'project' })
	})
})

describe('composeStoredMemoryPrompt', () => {
	it('names its section so it is never mistaken for curated memory', () => {
		expect(composeStoredMemoryPrompt({ text: '', total: 0, omitted: 0 })).toBeNull()
		const prompt = composeStoredMemoryPrompt({ text: '- [a](a.md) — b', total: 1, omitted: 0 })
		expect(prompt).toMatch(/^## Stored memories \(index\)\n/)
		expect(prompt).toContain('point-in-time')
		expect(prompt).not.toMatch(/durable|curated/i)
	})
})

describe('migrateMemoryOnce', () => {
	it('imports a JSON store with its ids, retires it, and is a no-op the second time', async () => {
		const directory = tempRoot()
		const cwd = tempRoot()
		const disk = new DiskMemoryStore({ baseDir: directory, directory })
		const { entry } = await disk.create({ title: 'Old fact', summary: 's', content: 'body' })
		await disk.update(entry.id, { status: 'archived' })
		const store = new MarkdownMemoryStore({ directory })

		const first = await migrateMemoryOnce({ store, directory, cwd })
		expect(first).toMatchObject({ importedRecords: 1, importedBullets: 0, problems: [] })
		expect(existsSync(join(directory, 'index.json'))).toBe(false)
		expect(readdirSync(directory)).toEqual(
			expect.arrayContaining(['index.json.migrated', 'content.migrated', 'old-fact.md']),
		)
		expect((await store.getRecord(entry.id))?.entry.status).toBe('archived')

		const second = await migrateMemoryOnce({ store, directory, cwd })
		expect(second).toMatchObject({ importedRecords: 0, importedBullets: 0, problems: [] })
	})

	it('moves a curated bullet once even when two launches race', async () => {
		const directory = tempRoot()
		const cwd = tempRoot()
		const { mkdirSync, writeFileSync } = await import('node:fs')
		mkdirSync(join(cwd, '.namzu'))
		writeFileSync(join(cwd, '.namzu', 'MEMORY.md'), '- use pnpm, not npm\n- keep prose\n')
		const reports = await Promise.all([
			migrateMemoryOnce({ store: new MarkdownMemoryStore({ directory }), directory, cwd }),
			migrateMemoryOnce({ store: new MarkdownMemoryStore({ directory }), directory, cwd }),
		])
		const store = new MarkdownMemoryStore({ directory })
		expect((await store.list()).entries.map((entry) => entry.name).sort()).toEqual([
			'keep-prose',
			'use-pnpm-not-npm',
		])
		expect(reports.reduce((total, report) => total + report.importedBullets, 0)).toBe(2)
		expect(readFileSync(join(cwd, '.namzu', 'MEMORY.md'), 'utf8')).toBe('')
		expect(readFileSync(join(cwd, '.namzu', 'MEMORY.md.before-typed-memory'), 'utf8')).toBe(
			'- use pnpm, not npm\n- keep prose\n',
		)
		// A later run finds the marker and moves nothing.
		writeFileSync(join(cwd, '.namzu', 'MEMORY.md'), '- written by hand later\n')
		expect(await migrateMemoryOnce({ store, directory, cwd })).toMatchObject({ importedBullets: 0 })
		expect(readFileSync(join(cwd, '.namzu', 'MEMORY.md'), 'utf8')).toBe('- written by hand later\n')
	})

	it('reports a JSON store it cannot read and leaves it in place', async () => {
		const directory = tempRoot()
		const disk = new DiskMemoryStore({ baseDir: directory, directory })
		const { entry } = await disk.create({ title: 'x', summary: 's', content: 'c' })
		const { writeFileSync } = await import('node:fs')
		writeFileSync(join(directory, 'content', `${entry.id}.json`), '{"id":1}')
		const store = new MarkdownMemoryStore({ directory })
		const report = await migrateMemoryOnce({ store, directory, cwd: tempRoot() })
		expect(report.problems.join('\n')).toContain('was not migrated')
		expect(existsSync(join(directory, 'index.json'))).toBe(true)
	})
})
