import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DiskMemoryStore, MarkdownMemoryStore } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import {
	type CuratedNotesImport,
	composeStoredMemoryPrompt,
	describeCuratedNotesImport,
	describeMemoryMigration,
	importCuratedNotes,
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
		const { bullets, rest, kept } = splitCuratedBullets(text)
		expect(bullets).toEqual(['one', 'two'])
		expect(rest).toBe(
			'# Notes\n\nSome prose.\n- multi-line note\nits unindented second line\n- parent\n  - nested\n',
		)
		// Both top-level bullets that stayed are counted; the nested one is not.
		expect(kept).toBe(2)
	})

	it('leaves nothing when the file held only bullets', () => {
		expect(splitCuratedBullets('- a\n- b\n')).toEqual({ bullets: ['a', 'b'], rest: '', kept: 0 })
	})

	it("leaves a heading's list where it is: that is a section the operator wrote", () => {
		const text = '## Conventions\n- use tabs\n- never push\n\n## Later\n\n- blank line first\n'
		expect(splitCuratedBullets(text)).toEqual({
			bullets: ['blank line first'],
			rest: '## Conventions\n- use tabs\n- never push\n\n## Later\n',
			kept: 2,
		})
	})

	it('offers the notes appendMemory left after a heading and a blank line', () => {
		expect(splitCuratedBullets('# Project memory\n\n- note one\n- note two\n')).toEqual({
			bullets: ['note one', 'note two'],
			rest: '# Project memory\n',
			kept: 0,
		})
	})

	it("ends a heading's list at a blank line, so notes appended after it are offered", () => {
		const text = '## Conventions\n- use tabs\n\n- appended note\n'
		expect(splitCuratedBullets(text)).toEqual({
			bullets: ['appended note'],
			rest: '## Conventions\n- use tabs\n',
			kept: 1,
		})
	})

	it('takes notes appended after prose even when a heading comes earlier', () => {
		const text = '## Context\n\nThe service is old.\n\n- appended note\n'
		expect(splitCuratedBullets(text)).toEqual({
			bullets: ['appended note'],
			rest: '## Context\n\nThe service is old.\n',
			kept: 0,
		})
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
		expect(first).toMatchObject({ importedRecords: 1, skippedRecords: [], problems: [] })
		expect(existsSync(join(directory, 'index.json'))).toBe(false)
		expect(readdirSync(directory)).toEqual(
			expect.arrayContaining(['index.json.migrated', 'content.migrated', 'old-fact.md']),
		)
		expect((await store.getRecord(entry.id))?.entry.status).toBe('archived')

		const second = await migrateMemoryOnce({ store, directory, cwd })
		expect(second).toMatchObject({ importedRecords: 0, skippedRecords: [], problems: [] })
	})

	it('skips a JSON record too large for a memory file and still retires the JSON store', async () => {
		const directory = tempRoot()
		const disk = new DiskMemoryStore({ baseDir: directory, directory })
		const big = await disk.create({ title: 'Huge', summary: 's', content: 'x'.repeat(300 * 1024) })
		await disk.create({ title: 'Small', summary: 's', content: 'c' })
		const store = new MarkdownMemoryStore({ directory })
		const report = await migrateMemoryOnce({ store, directory, cwd: tempRoot() })
		expect(report).toMatchObject({ importedRecords: 1, problems: [] })
		expect(report.skippedRecords).toHaveLength(1)
		expect(report.skippedRecords[0]).toContain(big.entry.id)
		expect(report.skippedRecords[0]).toContain(join(directory, 'content.migrated'))
		expect(existsSync(join(directory, 'index.json'))).toBe(false)
		expect(existsSync(join(directory, 'content.migrated', `${big.entry.id}.json`))).toBe(true)
		// The store works afterwards: the refused record never became a file.
		expect((await store.list()).entries.map((entry) => entry.name)).toEqual(['small'])
		await store.create({ title: 'after', summary: 's', content: 'c' })
	})

	it('reports a JSON store it cannot read and leaves it in place', async () => {
		const directory = tempRoot()
		const disk = new DiskMemoryStore({ baseDir: directory, directory })
		const { entry } = await disk.create({ title: 'x', summary: 's', content: 'c' })
		writeFileSync(join(directory, 'content', `${entry.id}.json`), '{"id":1}')
		const store = new MarkdownMemoryStore({ directory })
		const report = await migrateMemoryOnce({ store, directory, cwd: tempRoot() })
		expect(report.problems.join('\n')).toContain('was not migrated')
		expect(existsSync(join(directory, 'index.json'))).toBe(true)
	})

	it('offers curated notes once per file and moves nothing', async () => {
		const directory = tempRoot()
		const cwd = tempRoot()
		mkdirSync(join(cwd, '.namzu'))
		const curated = join(cwd, '.namzu', 'MEMORY.md')
		writeFileSync(curated, '- use pnpm, not npm\n')
		const store = new MarkdownMemoryStore({ directory })
		const first = await migrateMemoryOnce({ store, directory, cwd })
		expect(first.notesOffer).toEqual({ path: curated, count: 1 })
		expect(describeMemoryMigration(first, directory).join('\n')).toContain('/memory import-notes')
		expect(readFileSync(curated, 'utf8')).toBe('- use pnpm, not npm\n')
		expect((await store.list()).totalCount).toBe(0)
		expect((await migrateMemoryOnce({ store, directory, cwd })).notesOffer).toBeUndefined()
	})

	it('offers a second curated file the first launch did not resolve to', async () => {
		const directory = tempRoot()
		const root = tempRoot()
		const sub = join(root, 'pkg')
		mkdirSync(join(root, '.git'))
		mkdirSync(join(root, '.namzu'))
		mkdirSync(join(sub, '.namzu'), { recursive: true })
		writeFileSync(join(root, '.namzu', 'MEMORY.md'), '- root note\n')
		writeFileSync(join(sub, '.namzu', 'MEMORY.md'), '- package note\n')
		const store = new MarkdownMemoryStore({ directory })
		const fromRoot = await migrateMemoryOnce({ store, directory, cwd: root })
		const fromSub = await migrateMemoryOnce({ store, directory, cwd: sub })
		expect(fromRoot.notesOffer?.path).not.toBe(fromSub.notesOffer?.path)
		expect(fromSub.notesOffer?.count).toBe(1)
	})
})

describe('importCuratedNotes', () => {
	it('moves each curated note once even when two runs race, and keeps the file as it was', async () => {
		const directory = tempRoot()
		const cwd = tempRoot()
		mkdirSync(join(cwd, '.namzu'))
		const curated = join(cwd, '.namzu', 'MEMORY.md')
		writeFileSync(curated, '- use pnpm, not npm\n- keep prose\n')
		const results = await Promise.all([
			importCuratedNotes({ store: new MarkdownMemoryStore({ directory }), directory, cwd }),
			importCuratedNotes({ store: new MarkdownMemoryStore({ directory }), directory, cwd }),
		])
		const store = new MarkdownMemoryStore({ directory })
		expect((await store.list()).entries.map((entry) => entry.name).sort()).toEqual([
			'keep-prose',
			'use-pnpm-not-npm',
		])
		expect(results.reduce((total, result) => total + result.moved, 0)).toBe(2)
		expect(readFileSync(curated, 'utf8')).toBe('')
		expect(readFileSync(`${curated}.before-typed-memory`, 'utf8')).toBe(
			'- use pnpm, not npm\n- keep prose\n',
		)
		expect(describeCuratedNotesImport(results[0] as CuratedNotesImport, directory)).toContain(
			'.before-typed-memory',
		)
		// A launch after the move offers nothing for this file.
		writeFileSync(curated, '- written by hand later\n')
		expect((await migrateMemoryOnce({ store, directory, cwd })).notesOffer).toBeUndefined()
		expect(readFileSync(curated, 'utf8')).toBe('- written by hand later\n')
	})

	it("leaves a heading's list and says so", async () => {
		const directory = tempRoot()
		const cwd = tempRoot()
		mkdirSync(join(cwd, '.namzu'))
		const curated = join(cwd, '.namzu', 'MEMORY.md')
		writeFileSync(curated, '## Conventions\n- use tabs\n')
		const result = await importCuratedNotes({
			store: new MarkdownMemoryStore({ directory }),
			directory,
			cwd,
		})
		expect(result).toEqual({ path: curated, moved: 0, kept: 1 })
		expect(describeCuratedNotesImport(result, directory)).toContain(
			'1 bullet stayed: a list starting directly under a heading',
		)
		expect(readFileSync(curated, 'utf8')).toBe('## Conventions\n- use tabs\n')
	})

	it('keeps each run’s own text, and records the memories actually created', async () => {
		const directory = tempRoot()
		const cwd = tempRoot()
		mkdirSync(join(cwd, '.namzu'))
		const curated = join(cwd, '.namzu', 'MEMORY.md')
		const store = new MarkdownMemoryStore({ directory })
		writeFileSync(curated, '# Project memory\n\n- first note\n')
		const first = await importCuratedNotes({ store, directory, cwd })
		expect(first).toMatchObject({ moved: 1, backupPath: `${curated}.before-typed-memory` })
		// A note appended since, and one the first run already moved, copied back.
		writeFileSync(curated, '# Project memory\n\n- first note\n- second note\n')
		const second = await importCuratedNotes({ store, directory, cwd })
		expect(second).toMatchObject({ moved: 1, backupPath: `${curated}.before-typed-memory-2` })
		expect(readFileSync(`${curated}.before-typed-memory`, 'utf8')).toBe(
			'# Project memory\n\n- first note\n',
		)
		expect(readFileSync(`${curated}.before-typed-memory-2`, 'utf8')).toBe(
			'# Project memory\n\n- first note\n- second note\n',
		)
		expect(describeCuratedNotesImport(second, directory)).toContain(
			`before this move is kept at ${curated}.before-typed-memory-2`,
		)
		const marker = JSON.parse(readFileSync(join(directory, 'migration.json'), 'utf8'))
		expect(marker.curatedFiles[curated].moved).toBe(2)
		expect((await store.list()).totalCount).toBe(2)
	})

	it('offers notes appended after a heading at launch', async () => {
		const directory = tempRoot()
		const cwd = tempRoot()
		mkdirSync(join(cwd, '.namzu'))
		writeFileSync(join(cwd, '.namzu', 'MEMORY.md'), '# Project memory\n\n- note one\n- note two\n')
		const report = await migrateMemoryOnce({
			store: new MarkdownMemoryStore({ directory }),
			directory,
			cwd,
		})
		expect(report.notesOffer?.count).toBe(2)
	})
})
