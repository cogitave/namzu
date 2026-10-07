import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { blobPath, manifestPath, parseManifest } from '../manifest.js'
import { FileCheckpointStore, renderRestore, renderRestoreNote } from '../store.js'

// Real filesystem, no timers and no sleeps; Vitest's own timeout guards a hang.
let cwd: string
let historyRoot: string

const open = () => new FileCheckpointStore(historyRoot, cwd)

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), 'namzu-restore-'))
	historyRoot = join(cwd, '.namzu', 'file-history')
})

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true })
})

const T1 = '019a0000-0000-7000-8000-000000000001'
const T2 = '019a0000-0000-7000-8000-000000000002'
const T3 = '019a0000-0000-7000-8000-000000000003'

/** One edit as the wrapper makes it: snapshot, change, settle. */
async function edit(
	store: FileCheckpointStore,
	turnId: string,
	path: string,
	content: string | null,
): Promise<void> {
	await store.snapshot(path, { turnId, tool: 'edit', toolUseId: `call-${turnId}` })
	if (content === null) await unlink(path)
	else await writeFile(path, content)
	await store.settle(path, { ok: true, first: true, turnId })
}

const exists = (p: string) =>
	stat(p).then(
		() => true,
		() => false,
	)

describe('/restore through the plan', () => {
	it('undoes newest first and leaves a file the operator changed since, reporting why', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		const b = join(cwd, 'b.txt')
		await writeFile(a, 'v0')
		store.beginTurn('one', T1)
		await edit(store, T1, a, 'v1')
		store.beginTurn('two', T2)
		await edit(store, T2, a, 'v2')
		await edit(store, T2, b, 'created')
		await writeFile(a, 'the operator was here')

		const report = await store.restore(1)

		expect(await readFile(a, 'utf8')).toBe('the operator was here')
		expect(await exists(b)).toBe(false)
		expect(report.removed).toEqual([b])
		expect(report.restored).toEqual([])
		expect(report.conflicts).toEqual([
			{ path: a, turn: 2, reason: 'drifted' },
			{ path: a, turn: 1, reason: 'later-reply' },
		])
		expect(report.partialTurns).toEqual([2, 1])
		expect(report.undoneTurns).toEqual([])
		const text = renderRestore(report, cwd)
		expect(text).toContain('Restored part of the tree to before turn 1.')
		expect(text).toContain('removed  b.txt')
		expect(text).toContain('kept     a.txt  (turn 2: changed since the turn)')
		expect(text).toContain(
			'kept     a.txt  (turn 1: a later turn changed it and could not be undone)',
		)
		// Both turns stay listed: the rest of their work is still to sort out.
		// Turn 1 wrote nothing, so it is still simply applied.
		expect(store.list().map((t) => [t.index, t.status])).toEqual([
			[1, 'applied'],
			[2, 'partially_undone'],
		])
	})

	it('says nothing was put back when every file was left alone', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		store.beginTurn('one', T1)
		await edit(store, T1, a, 'v1')
		await writeFile(a, 'mine')
		const report = await store.restore(1)
		expect(renderRestore(report, cwd)).toContain('Nothing could be put back to before turn 1.')
		expect(await readFile(a, 'utf8')).toBe('mine')
	})

	it('a turn that was only partly undone does not block the older turn on the files it did take back', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		const c = join(cwd, 'c.txt')
		await writeFile(a, 'v0')
		await writeFile(c, 'c0')
		store.beginTurn('one', T1)
		await edit(store, T1, a, 'v1')
		store.beginTurn('two', T2)
		await edit(store, T2, a, 'v2')
		await edit(store, T2, c, 'c1')
		await writeFile(c, 'c by hand')

		const report = await store.restore(1)

		expect(await readFile(a, 'utf8')).toBe('v0')
		expect(await readFile(c, 'utf8')).toBe('c by hand')
		expect(report.restored).toEqual([a])
		expect(report.conflicts).toEqual([{ path: c, turn: 2, reason: 'drifted' }])
		expect(report.undoneTurns).toEqual([1])
		expect(report.partialTurns).toEqual([2])
	})

	it('a rerun after sorting out the conflict finishes the rest', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		store.beginTurn('one', T1)
		await edit(store, T1, a, 'v1')
		await writeFile(a, 'mine')
		await store.restore(1)
		expect(await readFile(a, 'utf8')).toBe('mine')

		// The operator puts the model's version back, then asks again.
		await writeFile(a, 'v1')
		const report = await store.restore(1)
		expect(await readFile(a, 'utf8')).toBe('v0')
		expect(report.restored).toEqual([a])
		expect(report.conflicts).toEqual([])
		expect(store.list()).toEqual([])
	})

	it('keeps the undone turns, their manifests and every body, so the restore can be taken back', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		const b = join(cwd, 'b.txt')
		await writeFile(a, 'v0')
		store.beginTurn('one', T1)
		await edit(store, T1, a, 'v1')
		store.beginTurn('two', T2)
		await edit(store, T2, b, 'made by the model')

		await store.restore(1)

		for (const id of [T1, T2]) {
			const m = parseManifest(await readFile(manifestPath(historyRoot, id), 'utf8'))
			expect(m?.status).toBe('undone')
			expect(m?.undone?.files.length).toBe(1)
			for (const e of m?.entries ?? []) {
				// The pre-turn body and the body the model left: Redo needs the second.
				if (e.before) expect(await exists(blobPath(historyRoot, e.before.sha256))).toBe(true)
				if (e.after) expect(await exists(blobPath(historyRoot, e.after.sha256))).toBe(true)
			}
		}
		expect(store.list()).toEqual([])
		await expect(store.restore(1)).rejects.toThrow(/No checkpoint for turn 1/)

		// A fresh process reads the same history and still sees them as undone.
		const again = open()
		await again.open()
		expect(again.list()).toEqual([])
		const preview = await again.previewUndo(T1)
		expect(preview.status).toBe('undone')
		expect(preview.files.map((f) => f.action)).toEqual(['noop'])
	})

	it('only reaches back as far as the turn asked for', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		store.beginTurn('one', T1)
		await edit(store, T1, a, 'v1')
		store.beginTurn('two', T2)
		await edit(store, T2, a, 'v2')
		store.beginTurn('three', T3)
		await edit(store, T3, a, 'v3')
		const report = await store.restore(2)
		expect(await readFile(a, 'utf8')).toBe('v1')
		expect(report.undoneTurns).toEqual([3, 2])
		expect(store.list().map((t) => t.index)).toEqual([1])
	})

	it('names what no history covers and that shell commands ran', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		store.beginTurn('one', T1)
		await edit(store, T1, a, 'v1')
		await store.recordSkip(join(cwd, 'big.bin'), 'too-large', T1)
		await store.noteShell(T1)
		const report = await store.restore(1)
		const text = renderRestore(report, cwd)
		expect(text).toContain('not covered big.bin  (too large)')
		expect(text).toContain('also ran shell commands')
	})
})

describe('the note the model reads after /restore', () => {
	it('carries the report, and warns that kept files hold what is on disk now', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		store.beginTurn('one', T1)
		await edit(store, T1, a, 'v1')
		await writeFile(a, 'mine')
		const note = renderRestoreNote(await store.restore(1), cwd)
		expect(note.startsWith('/restore 1\n')).toBe(true)
		expect(note).toContain('kept     a.txt')
		expect(note).toContain('Read them again before editing.')
	})

	it('is the plain report when everything went back', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		store.beginTurn('one', T1)
		await edit(store, T1, a, 'v1')
		const report = await store.restore(1)
		expect(renderRestoreNote(report, cwd)).toBe(`/restore 1\n${renderRestore(report, cwd)}`)
	})

	it('leaves a file that landed between the plan and the write', async () => {
		const store = new FileCheckpointStore(historyRoot, cwd, {
			hooks: {
				beforeWrite: async (path) => {
					await writeFile(path, 'raced in')
				},
			},
		})
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		store.beginTurn('one', T1)
		await edit(store, T1, a, 'v1')

		const report = await store.restore(1)

		expect(await readFile(a, 'utf8')).toBe('raced in')
		expect(report.restored).toEqual([])
		expect(report.conflicts.map((c) => c.path)).toEqual([a])
		expect(report.partialTurns).toEqual([1])
	})

	it('finishes after a crash that wrote the files but not the manifests', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		const made = join(cwd, 'made.txt')
		await writeFile(a, 'v0')
		store.beginTurn('one', T1)
		await edit(store, T1, a, 'v1')
		await edit(store, T1, made, 'new')
		// The crash: the files went back, the manifest never learned.
		await writeFile(a, 'v0')
		await unlink(made)

		const report = await open().restore(1)

		expect(await readFile(a, 'utf8')).toBe('v0')
		expect(await exists(made)).toBe(false)
		expect(report.conflicts).toEqual([])
		expect(report.undoneTurns).toEqual([1])
	})

	it('keeps a created file the operator went on editing, and one a later turn deleted comes back', async () => {
		const store = open()
		const made = join(cwd, 'made.txt')
		const gone = join(cwd, 'gone.txt')
		await writeFile(gone, 'precious')
		store.beginTurn('one', T1)
		await edit(store, T1, made, 'new')
		store.beginTurn('two', T2)
		await edit(store, T2, gone, null)
		await writeFile(made, 'new, and mine')

		const report = await store.restore(1)

		expect(await readFile(gone, 'utf8')).toBe('precious')
		expect(await readFile(made, 'utf8')).toBe('new, and mine')
		expect(report.conflicts).toEqual([{ path: made, turn: 1, reason: 'drifted' }])
	})
})
