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
	composeStoredMemoryPrompt,
	curatedBullets,
	describeCuratedNotesImport,
	describeMemoryMigration,
	importCuratedNotes,
	migrateMemoryOnce,
	saveTypedNote,
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

describe('curatedBullets', () => {
	it('takes every top-level bullet once, whatever surrounds it', () => {
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
			'- one',
			'',
		].join('\n')
		expect(curatedBullets(text)).toEqual(['one', 'two', 'multi-line note', 'parent'])
	})

	it("takes a heading's list, with or without a blank line under the heading", () => {
		expect(curatedBullets('## Conventions\n- use tabs\n')).toEqual(['use tabs'])
		expect(curatedBullets('## Conventions\n\n- use tabs\n- never push\n')).toEqual([
			'use tabs',
			'never push',
		])
		expect(curatedBullets('- a\r\n- b\r\n')).toEqual(['a', 'b'])
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
	function curatedFile(text: string): { cwd: string; curated: string } {
		const cwd = tempRoot()
		mkdirSync(join(cwd, '.namzu'))
		const curated = join(cwd, '.namzu', 'MEMORY.md')
		writeFileSync(curated, text)
		return { cwd, curated }
	}

	it('copies each bullet once even when two turns race, and never changes the file', async () => {
		const directory = tempRoot()
		const text = '- use pnpm, not npm\n- keep prose\n'
		const { cwd, curated } = curatedFile(text)
		const results = await Promise.all([
			importCuratedNotes({ store: new MarkdownMemoryStore({ directory }), directory, cwd }),
			importCuratedNotes({ store: new MarkdownMemoryStore({ directory }), directory, cwd }),
		])
		const store = new MarkdownMemoryStore({ directory })
		expect((await store.list()).entries.map((entry) => entry.name).sort()).toEqual([
			'keep-prose',
			'use-pnpm-not-npm',
		])
		expect(results.reduce((total, result) => total + result.copied, 0)).toBe(2)
		expect(readFileSync(curated, 'utf8')).toBe(text)
		expect(readdirSync(join(cwd, '.namzu'))).toEqual(['MEMORY.md'])
		// A launch after the import offers nothing for this file.
		expect((await migrateMemoryOnce({ store, directory, cwd })).notesOffer).toBeUndefined()
	})

	it("copies a heading's bullets when a blank line follows the heading, leaving the file whole", async () => {
		const directory = tempRoot()
		const text = '## Conventions\n\n- use tabs\n- never push\n'
		const { cwd, curated } = curatedFile(text)
		const store = new MarkdownMemoryStore({ directory })
		const result = await importCuratedNotes({ store, directory, cwd })
		expect(result).toEqual({ path: curated, found: 2, copied: 2, alreadyStored: 0 })
		expect(readFileSync(curated, 'utf8')).toBe(text)
		const report = describeCuratedNotesImport(result, directory)
		expect(report).toContain('Copied 2 of 2 bullets')
		expect(report).toContain(`${curated} is unchanged`)
		expect(report).toContain('Delete the ones you no longer want there yourself')
	})

	it('does not duplicate on a second import, a #note with the same text, or an archived copy', async () => {
		const directory = tempRoot()
		const { cwd, curated } = curatedFile('# Project memory\n\n- first note\n')
		const store = new MarkdownMemoryStore({ directory })
		expect(await importCuratedNotes({ store, directory, cwd })).toMatchObject({ copied: 1 })
		// Archived by the operator: it must not come back.
		const [first] = (await store.list()).entries
		await store.update(first?.id as never, { status: 'archived' })
		await saveTypedNote(store, 'saved with note')
		writeFileSync(curated, '# Project memory\n\n- first note\n- saved with note\n- second note\n')
		const second = await importCuratedNotes({ store, directory, cwd })
		expect(second).toMatchObject({ found: 3, copied: 1, alreadyStored: 2 })
		expect(describeCuratedNotesImport(second, directory)).toContain(
			'2 were already stored and not copied again.',
		)
		expect((await store.list()).totalCount).toBe(3)
		expect(await importCuratedNotes({ store, directory, cwd })).toMatchObject({ copied: 0 })
		expect((await store.list()).totalCount).toBe(3)
	})

	it('treats a memory holding the same text under the same name as stored', async () => {
		const directory = tempRoot()
		const { cwd } = curatedFile('- deploys need a changeset\n')
		const store = new MarkdownMemoryStore({ directory })
		await store.create({
			title: 'hand',
			summary: 's',
			content: 'deploys need a changeset',
			name: 'deploys-need-a-changeset',
		})
		expect(await importCuratedNotes({ store, directory, cwd })).toMatchObject({
			copied: 0,
			alreadyStored: 1,
		})
		expect((await store.list()).totalCount).toBe(1)
	})

	it('says so when there is nothing to copy', async () => {
		const directory = tempRoot()
		const { cwd, curated } = curatedFile('Just prose.\n')
		const result = await importCuratedNotes({
			store: new MarkdownMemoryStore({ directory }),
			directory,
			cwd,
		})
		expect(result).toEqual({ path: curated, found: 0, copied: 0, alreadyStored: 0 })
		expect(describeCuratedNotesImport(result, directory)).toBe(
			`No top-level bullets to copy in ${curated}; it is unchanged.`,
		)
	})

	it('offers a heading-and-blank-line list at launch without touching it', async () => {
		const directory = tempRoot()
		const { cwd, curated } = curatedFile('## Conventions\n\n- use tabs\n- never push\n')
		const report = await migrateMemoryOnce({
			store: new MarkdownMemoryStore({ directory }),
			directory,
			cwd,
		})
		expect(report.notesOffer?.count).toBe(2)
		expect(describeMemoryMigration(report, directory).join('\n')).toContain(
			'the curated file is never changed',
		)
		expect(readFileSync(curated, 'utf8')).toBe('## Conventions\n\n- use tabs\n- never push\n')
	})
})
