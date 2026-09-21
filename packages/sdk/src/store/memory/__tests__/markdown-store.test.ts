import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	stat,
	symlink,
	utimes,
	writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import type { MemoryId } from '../../../types/ids/index.js'
import type { MemoryRecord, MemoryType } from '../../../types/memory/index.js'
import { DiskMemoryStore } from '../disk.js'
import {
	MEMORY_INDEX_LINE_MAX_CHARS,
	MEMORY_INDEX_MAX_LINES,
	memoryIndexLine,
	renderMemoryIndex,
} from '../index-file.js'
import { formatMemoryFile, parseMemoryFile } from '../markdown-format.js'
import { MEMORY_FILE_MAX_BYTES, MEMORY_INDEX_FILE, MarkdownMemoryStore } from '../markdown.js'
import { MemoryContentRejectedError, MemoryNameConflictError } from '../naming.js'
import { acquireMemoryOperationLock } from '../operation-lock.js'

const roots: string[] = []
afterEach(async () => removeTempDirs(roots.splice(0)))

async function fixture(lockTimeoutMs?: number) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-markdown-memory-'))
	roots.push(root)
	const directory = join(root, 'memory')
	const store = new MarkdownMemoryStore({
		directory,
		...(lockTimeoutMs !== undefined ? { lockTimeoutMs } : {}),
	})
	return { root, directory, store }
}

describe('MarkdownMemoryStore keeps one Markdown file per memory', () => {
	it('writes the reference shape and reads it back unchanged', async () => {
		const { directory, store } = await fixture()
		const { entry, content } = await store.create({
			title: 'Tests need a built SDK',
			summary: 'The CLI tests import the SDK dist, so build it first.',
			content:
				'Run pnpm -r build before the CLI tests.\n\nWhy: the CLI resolves the SDK through dist.\nHow to apply: after an SDK change.',
			type: 'feedback',
			tags: ['testing'],
		})
		expect(entry).toMatchObject({
			name: 'tests-need-a-built-sdk',
			type: 'feedback',
			description: 'The CLI tests import the SDK dist, so build it first.',
			status: 'active',
		})
		const file = await readFile(join(directory, 'tests-need-a-built-sdk.md'), 'utf8')
		expect(file).toMatch(/^---\nname: tests-need-a-built-sdk\ndescription: /)
		expect(file).toContain('\ntype: feedback\nstatus: active\n')
		expect(file).toContain('\ntags: ["testing"]\n')
		expect(file).toContain(`\nid: ${JSON.stringify(entry.id).replace(/^"([a-z].*)"$/, '$1')}\n`)
		expect(file).toContain('---\n\nRun pnpm -r build before the CLI tests.\n\nWhy:')
		expect(await store.getRecord(entry.id)).toEqual({ entry, content })
		// A fresh instance — another process — reads the same record.
		expect(await new MarkdownMemoryStore({ directory }).getRecord(entry.id)).toEqual({
			entry,
			content,
		})
	})

	it('round-trips bodies with leading and trailing blank lines byte for byte', async () => {
		for (const body of [
			'',
			'\n',
			'x\n',
			'\nx',
			'\n\nx\n\n',
			'---\nnot a fence\n---',
			'a\r\nb',
			'a\r',
			'\r',
			'a\r\r',
			'a\r\n',
			'\ra',
		]) {
			const fields = {
				name: 'n',
				description: 'd',
				type: 'project' as const,
				status: 'active' as const,
				createdAt: 0,
				updatedAt: 0,
				tags: [],
				id: '00000000-0000-4000-8000-000000000000',
				title: 'n',
				summary: 'd',
				format: 'markdown' as const,
			}
			expect(parseMemoryFile(formatMemoryFile(fields, body), 'f').body).toBe(body)
		}
	})

	it('round-trips descriptions that need quoting', async () => {
		const { store } = await fixture()
		for (const description of [
			'Why: a colon',
			'true',
			'123',
			' padded ',
			'"quoted"',
			"it's",
			'#hash',
			'- dash',
		]) {
			const { entry } = await store.create({
				title: description,
				summary: 's',
				content: 'c',
				description,
			})
			expect((await store.getRecord(entry.id))?.entry.description).toBe(description)
		}
	})

	it('writes private files atomically, leaving no sidecars', async () => {
		const { directory, store } = await fixture()
		await store.create({ title: 'Private note', summary: 's', content: 'c' })
		const names = await readdir(directory)
		expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([])
		if (process.platform !== 'win32') {
			expect((await stat(join(directory, 'private-note.md'))).mode & 0o777).toBe(0o600)
			expect((await stat(join(directory, MEMORY_INDEX_FILE))).mode & 0o777).toBe(0o600)
			expect((await stat(directory)).mode & 0o777).toBe(0o700)
		}
	})
})

describe('names are unique', () => {
	it('refuses an explicit name another memory holds, naming the holder', async () => {
		const { store } = await fixture()
		const { entry } = await store.create({
			title: 'x',
			summary: 's',
			content: 'c',
			name: 'deploy-window',
		})
		const refusal = store.create({
			title: 'y',
			summary: 's',
			content: 'c',
			name: 'deploy-window',
		})
		await expect(refusal).rejects.toBeInstanceOf(MemoryNameConflictError)
		await expect(refusal).rejects.toMatchObject({
			existingId: entry.id,
			memoryName: 'deploy-window',
		})
		await expect(refusal).rejects.toThrow('Update that memory instead')
		expect((await store.list()).totalCount).toBe(1)
	})

	it('suffixes a name derived from a title', async () => {
		const { store } = await fixture()
		const first = await store.create({
			title: 'Same title',
			summary: 's',
			content: 'a',
		})
		const second = await store.create({
			title: 'Same title',
			summary: 's',
			content: 'b',
		})
		expect([first.entry.name, second.entry.name]).toEqual(['same-title', 'same-title-2'])
	})

	it('refuses an invalid name before writing', async () => {
		const { directory, store } = await fixture()
		for (const name of ['../escape', 'Upper', 'memory', 'a--b', '']) {
			await expect(
				store.create({ title: 't', summary: 's', content: 'c', name }),
			).rejects.toMatchObject({
				code: 'invalid_config',
			})
		}
		expect((await readdir(directory).catch(() => [])).filter((n) => n.endsWith('.md'))).toEqual([])
	})

	it('renames the file on a name update and refuses a taken name', async () => {
		const { directory, store } = await fixture()
		const a = await store.create({
			title: 'a',
			summary: 's',
			content: 'c',
			name: 'first',
		})
		await store.create({
			title: 'b',
			summary: 's',
			content: 'c',
			name: 'second',
		})
		await expect(store.update(a.entry.id, { name: 'second' })).rejects.toBeInstanceOf(
			MemoryNameConflictError,
		)
		await store.update(a.entry.id, { name: 'renamed' })
		const files = (await readdir(directory)).filter((n) => n.endsWith('.md')).sort()
		expect(files).toEqual([MEMORY_INDEX_FILE, 'renamed.md', 'second.md'])
		expect((await store.getRecord(a.entry.id))?.entry.name).toBe('renamed')
	})
})

describe('the generated MEMORY.md index', () => {
	it('lists active memories one line each and drops archived ones', async () => {
		const { directory, store } = await fixture()
		const kept = await store.create({
			title: 't',
			summary: 'Kept one',
			content: 'c',
			name: 'kept',
		})
		const gone = await store.create({
			title: 't',
			summary: 'Archived one',
			content: 'c',
			name: 'gone',
		})
		await store.update(gone.entry.id, { status: 'archived' })
		const file = await readFile(join(directory, MEMORY_INDEX_FILE), 'utf8')
		expect(file).toContain('- [kept](kept.md) — Kept one\n')
		expect(file).not.toContain('gone')
		expect(file.startsWith('<!-- Generated')).toBe(true)
		await store.delete(kept.entry.id)
		expect(await readFile(join(directory, MEMORY_INDEX_FILE), 'utf8')).not.toContain('kept')
	})

	it('keeps each line under 150 characters', async () => {
		const { store } = await fixture()
		await store.create({
			title: 't',
			summary: 's',
			content: 'c',
			name: 'long',
			description: 'x'.repeat(400),
		})
		const { text } = await store.readIndex()
		expect(text.length).toBeLessThanOrEqual(150)
		expect(text.endsWith('…')).toBe(true)
	})

	it('caps the prompt index at 200 lines and points to search for the rest', async () => {
		const { store } = await fixture()
		for (let i = 0; i < MEMORY_INDEX_MAX_LINES + 3; i++) {
			await store.create({
				title: `note ${String(i).padStart(3, '0')}`,
				summary: 's',
				content: 'c',
			})
		}
		const index = await store.readIndex()
		const lines = index.text.split('\n')
		expect(lines).toHaveLength(MEMORY_INDEX_MAX_LINES + 1)
		expect(index).toMatchObject({
			total: MEMORY_INDEX_MAX_LINES + 3,
			omitted: 3,
		})
		expect(lines.at(-1)).toBe(
			'(3 more memories are not listed here. Use search_memory to find them.)',
		)
	}, 60_000)

	it('never lists a record the runtime derived, and a derived write leaves the index as it was', async () => {
		const { directory, store } = await fixture()
		await store.create({ title: 't', summary: 'Chosen', content: 'c', name: 'chosen' })
		const before = await readFile(join(directory, MEMORY_INDEX_FILE), 'utf8')
		const promoted = await store.create({
			title: 'Fix the flaky test',
			summary: 'Decisions: retry once',
			content: '# Fix the flaky test',
			tags: ['run-memory'],
			metadata: { source: 'run-memory', runId: 'run_1' },
		})
		await new Promise((resolve) => setTimeout(resolve, 5))
		const consolidated = await store.create({
			title: 'Learned: fix the flaky test',
			summary: '1 decision from run run_1.',
			content: 'retry once',
			tags: ['learning'],
			metadata: { kind: 'consolidation', runId: 'run_1' },
		})
		expect(await readFile(join(directory, MEMORY_INDEX_FILE), 'utf8')).toBe(before)
		expect(await store.readIndex()).toEqual({
			text: '- [chosen](chosen.md) — Chosen',
			total: 1,
			omitted: 0,
		})
		// Still in the store, found by search.
		const found = (await store.list({ query: 'flaky' })).entries.map((entry) => entry.id)
		expect(found).toEqual(expect.arrayContaining([promoted.entry.id, consolidated.entry.id]))
		// An operator can list them on their own, newest first.
		const derived = await store.readIndex({ derived: true })
		expect(derived).toMatchObject({ total: 2, omitted: 0 })
		expect(derived.text.split('\n')).toEqual([
			expect.stringContaining(`[${consolidated.entry.name}]`),
			expect.stringContaining(`[${promoted.entry.name}]`),
		])
		expect(derived.text).not.toContain('chosen')
	})

	it('reflects a hand edit on the next read without a write', async () => {
		const { directory, store } = await fixture()
		const { entry } = await store.create({
			title: 't',
			summary: 'old',
			content: 'c',
			name: 'edited',
		})
		const path = join(directory, 'edited.md')
		await writeFile(
			path,
			(await readFile(path, 'utf8')).replace('description: old', 'description: new'),
		)
		expect((await store.readIndex()).text).toBe('- [edited](edited.md) — new')
		expect((await store.getRecord(entry.id))?.entry.description).toBe('new')
	})
})

describe('the index cap never drops an operator feedback or user memory for another', () => {
	let n = 0
	function record(name: string, type: MemoryType, source?: string): MemoryRecord {
		const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` as MemoryId
		return {
			entry: {
				id,
				name,
				description: name,
				type,
				title: name,
				summary: name,
				tags: [],
				status: 'active',
				createdAt: 0,
				updatedAt: 0,
			},
			content: {
				id,
				content: name,
				format: 'markdown',
				...(source ? { metadata: { source } } : {}),
			},
		}
	}

	it('orders operator feedback and user first, then the model’s, then the rest, by name within each', () => {
		const records = [
			record('aaa-project', 'project'),
			record('bbb-reference', 'reference'),
			record('ccc-model-feedback', 'feedback', 'agent-memory'),
			record('zzz-operator-feedback', 'feedback', 'operator-note'),
			record('yyy-hand-written-user', 'user'),
			record('aab-model-project', 'project', 'agent-memory'),
		]
		const { text } = renderMemoryIndex(records)
		expect(text.split('\n').map((line) => /\[(.+?)\]/.exec(line)?.[1])).toEqual([
			'yyy-hand-written-user',
			'zzz-operator-feedback',
			'ccc-model-feedback',
			'aaa-project',
			'aab-model-project',
			'bbb-reference',
		])
		// Stable: the same records in another order render the same text.
		expect(renderMemoryIndex([...records].reverse()).text).toBe(text)
	})

	it('drops project memories, not operator feedback, at the cap', () => {
		const records = [
			...Array.from({ length: 5 }, (_, i) => record(`a-project-${i}`, 'project')),
			record('z-operator-feedback', 'feedback'),
		]
		const index = renderMemoryIndex(records, { maxLines: 3 })
		expect(index.text.split('\n')[0]).toBe(
			'- [z-operator-feedback](z-operator-feedback.md) — z-operator-feedback',
		)
		expect(index).toMatchObject({ total: 6, omitted: 3 })
	})
})

describe('hand-written and malformed files', () => {
	it('reads a minimal hand-written file with a stable derived id and file-time dates', async () => {
		const { directory, store } = await fixture()
		await mkdir(directory, { recursive: true })
		await writeFile(
			join(directory, 'on-call.md'),
			'---\nname: on-call\ndescription: Who is on call\ntype: reference\ntags:\n  - ops\n---\nSee the rota.\n',
		)
		const [entry] = (await store.list()).entries
		expect(entry).toMatchObject({
			name: 'on-call',
			type: 'reference',
			tags: ['ops'],
			title: 'on-call',
		})
		expect((await store.list()).entries[0]?.id).toBe(entry?.id)
		expect((await store.get(entry?.id as MemoryId))?.content).toBe('See the rota.')
		// The first update writes the id down.
		await store.update(entry?.id as MemoryId, { content: 'See the new rota.' })
		expect(await readFile(join(directory, 'on-call.md'), 'utf8')).toContain('id: ')
		expect((await store.list()).entries[0]?.id).toBe(entry?.id)
	})

	it.each([
		['no frontmatter', 'just text\n', 'must start with a --- frontmatter fence'],
		['unclosed', '---\nname: bad\n', 'never closed'],
		[
			'unknown key',
			'---\nname: bad\ndescription: d\ntype: project\nowner: me\n---\n',
			'unknown key "owner"',
		],
		['repeated key', '---\nname: bad\nname: bad\n---\n', 'appears twice'],
		['wrong type', '---\nname: bad\ndescription: d\ntype: opinion\n---\n', 'type must be'],
		['missing description', '---\nname: bad\ntype: project\n---\n', 'description is required'],
		[
			'name mismatch',
			'---\nname: other\ndescription: d\ntype: project\n---\n',
			'does not match the file name',
		],
		[
			'tags that are not a JSON list',
			'---\nname: bad\ndescription: d\ntype: project\ntags: [a, b]\n---\n',
			'tags must be a list of strings',
		],
		[
			'an unterminated quoted string',
			'---\nname: bad\ndescription: "open\ntype: project\n---\n',
			'valid JSON string',
		],
		['block scalar', '---\nname: bad\ndescription: >\ntype: project\n---\n', 'block scalars'],
		[
			'newer schema',
			'---\nname: bad\ndescription: d\ntype: project\nschemaVersion: 2\n---\n',
			'schema version 2',
		],
	])('refuses %s rather than treating the store as smaller', async (_label, raw, reason) => {
		const { directory, store } = await fixture()
		await mkdir(directory, { recursive: true })
		await writeFile(join(directory, 'bad.md'), raw)
		await expect(store.list()).rejects.toThrow(reason)
		await expect(store.create({ title: 't', summary: 's', content: 'c' })).rejects.toMatchObject({
			code: 'storage_error',
		})
		expect(await readFile(join(directory, 'bad.md'), 'utf8')).toBe(raw)
	})

	it('refuses two files claiming one id', async () => {
		const { directory, store } = await fixture()
		const { entry } = await store.create({
			title: 't',
			summary: 's',
			content: 'c',
			name: 'one',
		})
		const copy = (await readFile(join(directory, 'one.md'), 'utf8')).replace(
			'name: one',
			'name: two',
		)
		await writeFile(join(directory, 'two.md'), copy)
		await expect(store.list()).rejects.toThrow(`claims id ${entry.id}`)
	})

	it('refuses a hand copy with no updatedAt of its own rather than setting the older aside', async () => {
		const { directory, store } = await fixture()
		await mkdir(directory, { recursive: true })
		const id = '0b6c2a4e-1111-4222-8333-444455556666'
		const one = `---\nname: one\ndescription: d\ntype: project\nid: ${id}\n---\n\nbody\n`
		await writeFile(join(directory, 'one.md'), one)
		await new Promise((resolve) => setTimeout(resolve, 20))
		await writeFile(join(directory, 'two.md'), one.replace('name: one', 'name: two'))
		await expect(store.list()).rejects.toThrow(`claims id ${id}`)
		await expect(store.create({ title: 't', summary: 's', content: 'c' })).rejects.toThrow(
			`claims id ${id}`,
		)
		const files = await readdir(directory)
		expect(files).toEqual(expect.arrayContaining(['one.md', 'two.md']))
		expect(files.some((file) => file.includes('superseded'))).toBe(false)
	})

	it('refuses a NUL character a quoted frontmatter value spells out', async () => {
		const { directory, store } = await fixture()
		await mkdir(directory, { recursive: true })
		await writeFile(
			join(directory, 'nul.md'),
			'---\nname: nul\ndescription: "a\\u0000b"\ntype: project\n---\n\nbody\n',
		)
		await expect(store.list()).rejects.toThrow('description contains a NUL character')
	})

	it.skipIf(process.platform === 'win32')('refuses a symlinked memory file', async () => {
		const { root, directory, store } = await fixture()
		await mkdir(directory, { recursive: true })
		const outside = join(root, 'outside.md')
		await writeFile(outside, '---\nname: linked\ndescription: d\ntype: project\n---\n')
		await symlink(outside, join(directory, 'linked.md'))
		await expect(store.list()).rejects.toThrow('must not be a symlink')
	})

	it('ignores non-memory files beside the memories', async () => {
		const { directory, store } = await fixture()
		await mkdir(join(directory, 'content'), { recursive: true })
		await writeFile(join(directory, 'notes.txt'), 'x')
		expect((await store.list()).totalCount).toBe(0)
	})

	it('refuses everything but an import while a JSON store index is unmigrated', async () => {
		const { root, directory, store } = await fixture()
		await mkdir(directory, { recursive: true })
		await writeFile(join(directory, 'index.json'), '[]')
		await expect(store.list()).rejects.toThrow('has not been migrated')
		await expect(store.readIndex()).rejects.toMatchObject({ code: 'storage_error' })
		const disk = new DiskMemoryStore({ baseDir: join(root, 'old') })
		const { entry } = await disk.create({ title: 'old', summary: 's', content: 'c' })
		const record = await disk.getRecord(entry.id)
		if (!record) throw new Error('fixture record missing')
		expect(await store.importRecord(record)).toBe('imported')
	})
})

describe('coordination', () => {
	it('shares the operation lock with DiskMemoryStore on the same directory', async () => {
		const { directory, store } = await fixture(25)
		await store.list()
		const release = await acquireMemoryOperationLock(join(directory, 'operation.lock'), 25)
		try {
			await expect(store.list()).rejects.toThrow('acquisition timed out after 25 ms')
			await expect(
				new DiskMemoryStore({
					baseDir: directory,
					directory,
					lockTimeoutMs: 25,
				}).list(),
			).rejects.toThrow('acquisition timed out')
		} finally {
			await release()
		}
	})

	it('keeps every concurrent create', async () => {
		const { store } = await fixture()
		await Promise.all(
			Array.from({ length: 12 }, (_, i) =>
				store.create({ title: `parallel ${i}`, summary: 's', content: 'c' }),
			),
		)
		expect((await store.list()).totalCount).toBe(12)
	})
})

describe('importRecord', () => {
	it('keeps id, timestamps, status and metadata, and is idempotent by id', async () => {
		const { root, store } = await fixture()
		const disk = new DiskMemoryStore({ baseDir: join(root, 'old') })
		const { entry } = await disk.create({
			title: 'Old record',
			summary: 'From the JSON store',
			content: 'body',
			tags: ['run-memory'],
			metadata: { runId: 'r1' },
		})
		await disk.update(entry.id, { status: 'archived' })
		const record = await disk.getRecord(entry.id)
		if (!record) throw new Error('fixture record missing')
		expect(await store.importRecord(record)).toBe('imported')
		expect(await store.importRecord(record)).toBe('present')
		const imported = await store.getRecord(entry.id)
		expect(imported?.entry).toMatchObject({
			id: entry.id,
			name: 'old-record',
			type: 'project',
			status: 'archived',
			createdAt: record.entry.createdAt,
			updatedAt: record.entry.updatedAt,
			tags: ['run-memory'],
		})
		expect(imported?.content).toEqual(record.content)
	})
})

describe('what the loader refuses is never written', () => {
	it('refuses content over the file limit before writing, and the store keeps working', async () => {
		const { directory, store } = await fixture()
		const kept = await store.create({ title: 'kept', summary: 's', content: 'c' })
		const big = 'x'.repeat(300 * 1024)
		await expect(store.create({ title: 'big', summary: 's', content: big })).rejects.toMatchObject({
			name: 'MemoryContentRejectedError',
			reason: 'too_large',
			limit: MEMORY_FILE_MAX_BYTES,
		})
		await expect(store.update(kept.entry.id, { content: big })).rejects.toBeInstanceOf(
			MemoryContentRejectedError,
		)
		expect((await readdir(directory)).filter((file) => file.endsWith('.md')).sort()).toEqual([
			MEMORY_INDEX_FILE,
			'kept.md',
		])
		expect((await store.list()).totalCount).toBe(1)
		expect((await store.get(kept.entry.id))?.content).toBe('c')
		await store.create({ title: 'next', summary: 's', content: 'c' })
		expect((await store.list()).totalCount).toBe(2)
	})

	it('counts the bytes on disk, not the characters', async () => {
		const { store } = await fixture()
		// Four bytes each in UTF-8: under the limit in characters, over it in bytes.
		const wide = '😀'.repeat(MEMORY_FILE_MAX_BYTES / 4)
		await expect(
			store.create({ title: 'wide', summary: 's', content: wide }),
		).rejects.toMatchObject({
			reason: 'too_large',
		})
	})

	it('refuses a NUL character before writing', async () => {
		const { store } = await fixture()
		await expect(
			store.create({ title: 'nul', summary: 's', content: 'a\u0000b' }),
		).rejects.toMatchObject({
			reason: 'nul_byte',
		})
		expect((await store.list()).totalCount).toBe(0)
	})

	it.each([
		['title', { title: 'a\u0000b' }],
		['summary', { summary: 'a\u0000b' }],
		['description', { description: 'a\u0000b' }],
		['a tag', { tags: ['a\u0000b'] }],
	])('refuses a NUL character in %s before writing', async (_label, field) => {
		const { store } = await fixture()
		await expect(
			store.create({ title: 'nul', summary: 's', content: 'c', ...field }),
		).rejects.toMatchObject({ reason: 'nul_byte' })
		expect((await store.list()).totalCount).toBe(0)
		const { entry } = await store.create({ title: 'ok', summary: 's', content: 'c' })
		await expect(store.update(entry.id, field)).rejects.toMatchObject({ reason: 'nul_byte' })
		expect((await store.readIndex()).text).not.toContain('\u0000')
	})

	it('refuses an oversized import without writing it, so later imports still run', async () => {
		const { root, store } = await fixture()
		const disk = new DiskMemoryStore({ baseDir: join(root, 'old') })
		const big = await disk.create({ title: 'big', summary: 's', content: 'x'.repeat(300 * 1024) })
		const small = await disk.create({ title: 'small', summary: 's', content: 'c' })
		const bigRecord = await disk.getRecord(big.entry.id)
		const smallRecord = await disk.getRecord(small.entry.id)
		if (!bigRecord || !smallRecord) throw new Error('fixture records missing')
		await expect(store.importRecord(bigRecord)).rejects.toBeInstanceOf(MemoryContentRejectedError)
		expect(await store.importRecord(smallRecord)).toBe('imported')
		expect((await store.list()).entries.map((entry) => entry.name)).toEqual(['small'])
	})
})

describe('recoverable hand edits and interrupted writes', () => {
	it('reads a description that opens with a bracket as the string it is', async () => {
		const { directory, store } = await fixture()
		await mkdir(directory, { recursive: true })
		await writeFile(
			join(directory, 'deploy.md'),
			'---\nname: deploy\ndescription: [WIP] deploy notes\ntype: project\n---\n\nbody\n',
		)
		const [entry] = (await store.list()).entries
		expect(entry?.description).toBe('[WIP] deploy notes')
		// A write quotes it, and it reads back the same.
		await store.update(entry?.id as MemoryId, { content: 'body 2' })
		expect(await readFile(join(directory, 'deploy.md'), 'utf8')).toContain(
			'description: "[WIP] deploy notes"',
		)
		expect((await store.list()).entries[0]?.description).toBe('[WIP] deploy notes')
	})

	it('reads the newer of two files left by an interrupted rename and sets the older aside on the next write', async () => {
		const { directory, store } = await fixture()
		const { entry } = await store.create({
			title: 't',
			summary: 's',
			content: 'old',
			name: 'before',
		})
		const old = await readFile(join(directory, 'before.md'), 'utf8')
		await store.update(entry.id, { name: 'after', content: 'new' })
		// The crash: the renamed file is written, the old one never unlinked.
		await writeFile(join(directory, 'before.md'), old)
		expect((await store.getRecord(entry.id))?.content.content).toBe('new')
		expect((await store.list()).entries.map((candidate) => candidate.name)).toEqual(['after'])
		// A read leaves the directory alone.
		expect(await readdir(directory)).toContain('before.md')
		await store.create({ title: 'other', summary: 's', content: 'c' })
		const files = await readdir(directory)
		expect(files).not.toContain('before.md')
		expect(files).toContain('before.md.superseded')
		expect(await readFile(join(directory, 'before.md.superseded'), 'utf8')).toBe(old)
	})

	it('recovers an interrupted rename of a hand-written file by its mtime', async () => {
		const { directory, store } = await fixture()
		await mkdir(directory, { recursive: true })
		const old = '---\nname: before\ndescription: d\ntype: project\n---\n\nold\n'
		const oldPath = join(directory, 'before.md')
		await writeFile(oldPath, old)
		const oldTime = new Date(Date.now() - 60_000)
		await utimes(oldPath, oldTime, oldTime)
		const [entry] = (await store.list()).entries
		await store.update(entry?.id as MemoryId, { name: 'after', content: 'new' })
		// The crash: the renamed file is written, the hand-written one never
		// unlinked, so it keeps its old mtime.
		await writeFile(oldPath, old)
		await utimes(oldPath, oldTime, oldTime)
		expect((await store.getRecord(entry?.id as MemoryId))?.content.content).toBe('new')
		expect((await store.list()).entries.map((candidate) => candidate.name)).toEqual(['after'])
		expect((await store.readIndex()).text).toContain('[after](after.md)')
		await store.create({ title: 'other', summary: 's', content: 'c' })
		const files = await readdir(directory)
		expect(files).not.toContain('before.md')
		expect(await readFile(join(directory, 'before.md.superseded'), 'utf8')).toBe(old)
	})

	it('still refuses an undated file that states the id a dated file also states', async () => {
		const { directory, store } = await fixture()
		const { entry } = await store.create({ title: 't', summary: 's', content: 'c', name: 'one' })
		await writeFile(
			join(directory, 'two.md'),
			`---\nname: two\ndescription: d\ntype: project\nid: ${entry.id}\n---\n\nbody\n`,
		)
		await expect(store.list()).rejects.toThrow(
			new RegExp(`two\\.md is invalid: claims id ${entry.id}, which .*one\\.md also claims`),
		)
	})
})

describe('index lines stay inside their budget', () => {
	it('never exceeds 150 characters, even with a name at the length limit', () => {
		const name = 'a'.repeat(64)
		const line = memoryIndexLine({ name, description: 'd'.repeat(200), summary: 's' })
		expect(line.length).toBeLessThanOrEqual(MEMORY_INDEX_LINE_MAX_CHARS)
		expect(line.startsWith(`- [${name}](${name}.md) — `)).toBe(true)
	})

	it('leaves a derived name enough room for the description to be read', async () => {
		const { store } = await fixture()
		const note =
			'Always run pnpm -r build before running the CLI tests because they import the SDK dist output'
		await store.create({ title: note, summary: note, description: note, content: note })
		const { text } = await store.readIndex()
		expect(text.length).toBeLessThanOrEqual(MEMORY_INDEX_LINE_MAX_CHARS)
		expect(text).toMatch(
			/^- \[always-run-pnpm-r-build-before\]\(always-run-pnpm-r-build-before\.md\) — /,
		)
		expect(text).toContain('Always run pnpm -r build before running the CLI tests')
	})
})
