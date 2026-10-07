import {
	chmod,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	symlink,
	unlink,
	writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ToolContext, ToolDefinition, ToolResult } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { blobPath, hashBytes, manifestPath, parseManifest, writeManifest } from '../manifest.js'
import {
	FileCheckpointStore,
	type StoreOptions,
	type UndoOutcome,
	type UndoPreview,
} from '../store.js'
import { withCheckpoints, withShellNote } from '../wrap.js'

// Real filesystem, no timers and no sleeps: retention reads an injected clock,
// and a hang is caught by Vitest's own per-test timeout.
let cwd: string
let historyRoot: string
let clock = 1_000_000

const open = (options: StoreOptions = {}) =>
	new FileCheckpointStore(historyRoot, cwd, { now: () => clock, ...options })

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), 'namzu-history-'))
	historyRoot = join(cwd, '.namzu', 'file-history')
	clock = 1_000_000
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
	ok = true,
): Promise<void> {
	await store.snapshot(path, { turnId, tool: 'edit', toolUseId: `call-${turnId}` })
	if (content === null) await unlink(path)
	else await writeFile(path, content)
	await store.settle(path, { ok, first: true, turnId })
}

const exists = (p: string) =>
	stat(p).then(
		() => true,
		() => false,
	)

async function undoNow(
	store: FileCheckpointStore,
	turnId: string,
	extra: { alsoUndoLater?: boolean; resolutions?: Record<string, 'skip' | 'keep_copy'> } = {},
): Promise<Extract<UndoOutcome, { kind: 'applied' }>> {
	const preview = await store.previewUndo(turnId, { alsoUndoLater: extra.alsoUndoLater })
	const out = await store.undo(turnId, { planToken: preview.planToken, ...extra })
	if (out.kind !== 'applied') throw new Error('plan changed')
	return out
}

describe('history keyed by the journal turn', () => {
	it('writes one manifest per TurnId with the before and after bodies', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		store.beginTurn('first prompt', T1)
		await edit(store, T1, a, 'v1')

		const manifest = parseManifest(await readFile(manifestPath(historyRoot, T1), 'utf8'))
		expect(manifest).toMatchObject({
			version: 1,
			turnId: T1,
			seq: 1,
			label: 'first prompt',
			status: 'applied',
			uncoveredShell: false,
		})
		const entry = manifest?.entries[0]
		expect(entry).toMatchObject({ rel: 'a.txt', root: 'cwd', tool: 'edit', state: 'done' })
		expect(entry?.before?.sha256).toBe(hashBytes(Buffer.from('v0')))
		expect(entry?.after?.sha256).toBe(hashBytes(Buffer.from('v1')))
		expect((await readFile(blobPath(historyRoot, entry?.before?.sha256 ?? ''))).toString()).toBe(
			'v0',
		)
		expect((await readFile(blobPath(historyRoot, entry?.after?.sha256 ?? ''))).toString()).toBe(
			'v1',
		)
	})

	it('numbers turns by sequence, not by position, and never reuses a number', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		store.beginTurn('empty prompt', T1)
		store.beginTurn('edits', T2)
		await edit(store, T2, a, 'v1')
		store.beginTurn('more', T3)
		await edit(store, T3, a, 'v2')
		expect(store.list().map((t) => [t.index, t.turnId])).toEqual([
			[1, T2],
			[2, T3],
		])
		await store.restore(2)
		store.beginTurn('later', '019a0000-0000-7000-8000-000000000004')
		await edit(store, '019a0000-0000-7000-8000-000000000004', a, 'v9')
		expect(store.list().map((t) => t.index)).toEqual([1, 3])
	})

	it('keeps the first before and the last after when one turn writes a path twice', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(store, T1, a, 'v1')
		await store.snapshot(a, { turnId: T1 })
		await writeFile(a, 'v2')
		await store.settle(a, { ok: true, first: false, turnId: T1 })
		const m = parseManifest(await readFile(manifestPath(historyRoot, T1), 'utf8'))
		expect(m?.entries).toHaveLength(1)
		expect(m?.entries[0]?.before?.sha256).toBe(hashBytes(Buffer.from('v0')))
		expect(m?.entries[0]?.after?.sha256).toBe(hashBytes(Buffer.from('v2')))
	})

	it('puts an edit from a turn nobody began in that turn, not in a stray bucket', async () => {
		const store = open()
		store.beginTurn('the live prompt', T1)
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		// A resumed stream's edit names its own turn.
		await edit(store, T2, a, 'v1')
		expect(store.list().map((t) => t.turnId)).toEqual([T2])
		expect(await exists(manifestPath(historyRoot, T2))).toBe(true)
	})

	it('reads the turn from the tool context in the wrapper', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		const tool = {
			name: 'edit',
			execute: async (): Promise<ToolResult> => {
				await writeFile(a, 'v1')
				return { success: true, output: '' }
			},
		} as unknown as ToolDefinition
		const ctx = {
			workingDirectory: cwd,
			abortSignal: new AbortController().signal,
			env: {},
			log: () => {},
			turnId: T2,
			toolUseId: 'tu-9',
		} as unknown as ToolContext
		store.beginTurn('another prompt', T1)
		await withCheckpoints(tool, store).execute({ path: a }, ctx)
		const m = parseManifest(await readFile(manifestPath(historyRoot, T2), 'utf8'))
		expect(m?.entries[0]).toMatchObject({ tool: 'edit', toolUseId: 'tu-9', state: 'done' })
		expect(m?.entries[0]?.after).not.toBeNull()
	})

	it('records that a shell call ran, with the turn', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		const shell = withShellNote(
			{
				name: 'bash',
				execute: async () => ({ success: true, output: '' }),
			} as unknown as ToolDefinition,
			store,
		)
		const ctx = { turnId: T1, log: () => {} } as unknown as ToolContext
		await shell.execute({}, ctx)
		await edit(store, T1, a, 'v1')
		// And once the turn has a manifest, a later call still lands in it.
		await shell.execute({}, ctx)
		expect(
			parseManifest(await readFile(manifestPath(historyRoot, T1), 'utf8'))?.uncoveredShell,
		).toBe(true)
	})
})

describe('reopening', () => {
	it('round-trips a manifest, and lists it after a release and a new store', async () => {
		const first = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		first.beginTurn('edit a', T1)
		await edit(first, T1, a, 'v1')
		await first.release()

		const second = open()
		expect(second.list()).toEqual([])
		await second.open()
		expect(second.list()).toMatchObject([
			{ turnId: T1, label: 'edit a', files: [a], status: 'applied' },
		])
	})

	it('marks an entry whose before body is gone as unavailable, and writes nothing for it', async () => {
		const first = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(first, T1, a, 'v1')
		await first.release()
		await rm(blobPath(historyRoot, hashBytes(Buffer.from('v0'))))

		const second = open()
		await second.open()
		const preview = await second.previewUndo(T1)
		expect(preview.files[0]).toMatchObject({ action: 'conflict', reason: 'unavailable' })
		const out = await second.undo(T1, { planToken: preview.planToken })
		expect(out).toMatchObject({ kind: 'applied', files: { [a]: 'skipped' } })
		expect(await readFile(a, 'utf8')).toBe('v1')
	})

	it('settles an entry a crash left pending: still the before state means it never happened', async () => {
		const first = open()
		const a = join(cwd, 'a.txt')
		const b = join(cwd, 'b.txt')
		await writeFile(a, 'a0')
		await writeFile(b, 'b0')
		await first.snapshot(a, { turnId: T1 })
		await first.snapshot(b, { turnId: T1 })
		// The process dies here. a was written, b was not.
		await writeFile(a, 'a1')
		await first.release()

		const second = open()
		await second.open()
		const m = parseManifest(await readFile(manifestPath(historyRoot, T1), 'utf8'))
		expect(m?.entries.map((e) => [e.rel, e.state])).toEqual([['a.txt', 'done']])
		expect(m?.entries[0]?.after?.sha256).toBe(hashBytes(Buffer.from('a1')))
		expect(second.list()[0]?.files).toEqual([a])
	})

	it('does not read a manifest it does not understand, and does not trip over it', async () => {
		const first = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(first, T1, a, 'v1')
		await first.release()
		await writeFile(join(historyRoot, 'turns', 'junk.json'), '{ nope')
		await writeFile(
			join(historyRoot, 'turns', `${T2}.json`),
			JSON.stringify({ version: 2, turnId: T2 }),
		)
		const second = open()
		await second.open()
		expect(second.list().map((t) => t.turnId)).toEqual([T1])
	})

	it('edit, release, reopen in a new store, undo', async () => {
		const first = open()
		const a = join(cwd, 'a.txt')
		const made = join(cwd, 'made.txt')
		await writeFile(a, 'before')
		first.beginTurn('change one, make one', T1)
		await edit(first, T1, a, 'after')
		await edit(first, T1, made, 'new')
		await first.release()

		const second = open()
		await second.open()
		const out = await undoNow(second, T1)
		expect(out.status).toBe('undone')
		expect(out.files).toEqual({ [a]: 'restored', [made]: 'removed' })
		expect(await readFile(a, 'utf8')).toBe('before')
		expect(await exists(made)).toBe(false)
		expect([...out.changed].sort()).toEqual([a, made].sort())
	})
})

describe('undo', () => {
	it('is a noop the second time, and keeps the turn undone', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(store, T1, a, 'v1')
		await undoNow(store, T1)
		const again = await undoNow(store, T1)
		expect(again.files).toEqual({ [a]: 'noop' })
		expect(again.status).toBe('undone')
		expect(again.changed).toEqual([])
		expect(store.list()).toEqual([])
	})

	it('refuses a file the operator changed after the reply, and saves nothing over it', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(store, T1, a, 'v1')
		await writeFile(a, 'mine')
		const out = await undoNow(store, T1)
		expect(out.files).toEqual({ [a]: 'skipped' })
		expect(out.status).toBe('applied')
		expect(await readFile(a, 'utf8')).toBe('mine')
	})

	it('restores anyway on request, keeping a copy of the operator version', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(store, T1, a, 'v1')
		await writeFile(a, 'mine')
		const out = await undoNow(store, T1, { resolutions: { [a]: 'keep_copy' } })
		expect(out.files).toEqual({ [a]: 'restored' })
		expect(await readFile(a, 'utf8')).toBe('v0')
		expect(out.copies).toHaveLength(1)
		const kept = await readFile(blobPath(historyRoot, out.copies[0]?.sha256 ?? ''), 'utf8')
		expect(kept).toBe('mine')
		const m = parseManifest(await readFile(manifestPath(historyRoot, T1), 'utf8'))
		expect(m?.copies?.[0]?.path).toBe(a)
	})

	it('names the operator copy in the manifest before the file is replaced', async () => {
		let seen: string[] | undefined
		const store = open({
			hooks: {
				// The moment a crash would leave the operator's only copy to the orphan sweep.
				beforeWrite: async () => {
					const m = parseManifest(await readFile(manifestPath(historyRoot, T1), 'utf8'))
					seen = m?.copies?.map((c) => c.sha256)
				},
			},
		})
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(store, T1, a, 'v1')
		await writeFile(a, 'mine')
		const out = await undoNow(store, T1, { resolutions: { [a]: 'keep_copy' } })
		expect(seen).toEqual([out.copies[0]?.sha256])
		const m = parseManifest(await readFile(manifestPath(historyRoot, T1), 'utf8'))
		expect(m?.copies).toHaveLength(1)
	})

	it('never deletes a created file that is no longer what the turn wrote', async () => {
		const store = open()
		const made = join(cwd, 'made.txt')
		await edit(store, T1, made, 'model')
		await writeFile(made, 'operator took it over')
		const out = await undoNow(store, T1)
		expect(out.files).toEqual({ [made]: 'skipped' })
		expect(await readFile(made, 'utf8')).toBe('operator took it over')
	})

	it('refuses a path that became a symlink, and writes nothing through it', async () => {
		if (process.platform === 'win32') return
		const store = open()
		const a = join(cwd, 'a.txt')
		const elsewhere = join(cwd, 'elsewhere.txt')
		await writeFile(a, 'v0')
		await writeFile(elsewhere, 'untouched')
		await edit(store, T1, a, 'v1')
		await rm(a)
		await symlink(elsewhere, a)
		const preview = await store.previewUndo(T1)
		expect(preview.files[0]).toMatchObject({ action: 'conflict', reason: 'symlink' })
		await undoNow(store, T1)
		expect(await readFile(elsewhere, 'utf8')).toBe('untouched')
	})

	it('treats a mode-only change after the reply as drift and leaves the file alone', async () => {
		if (process.platform === 'win32') return
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(store, T1, a, 'v1')
		await chmod(a, 0o700)
		const out = await undoNow(store, T1)
		expect(out.files).toEqual({ [a]: 'skipped' })
		expect(await readFile(a, 'utf8')).toBe('v1')
	})

	it('keeps the mode bits of the file it restores', async () => {
		if (process.platform === 'win32') return
		const store = open()
		const a = join(cwd, 'run.sh')
		await writeFile(a, '#!/bin/sh\n')
		await chmod(a, 0o751)
		await edit(store, T1, a, 'changed')
		await chmod(a, 0o751)
		// The chmod after the settle is drift by design; re-settle to record it.
		await store.snapshot(a, { turnId: T1 })
		await store.settle(a, { ok: true, first: false, turnId: T1 })
		await undoNow(store, T1)
		expect((await stat(a)).mode & 0o7777).toBe(0o751)
		expect(await readFile(a, 'utf8')).toBe('#!/bin/sh\n')
	})

	it('refuses to undo under a later reply that changed the same file, unless asked', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(store, T1, a, 'v1')
		await edit(store, T2, a, 'v2')
		const blocked = await store.previewUndo(T1)
		expect(blocked.files[0]).toMatchObject({ reason: 'later-reply', blockedBy: [T2] })
		expect(blocked.laterTurnsOnSameFiles).toEqual([T2])
		expect((await undoNow(store, T1)).files).toEqual({ [a]: 'skipped' })
		expect(await readFile(a, 'utf8')).toBe('v2')

		const both = await undoNow(store, T1, { alsoUndoLater: true })
		expect(both.files).toEqual({ [a]: 'restored' })
		expect(both.later).toEqual({ [T2]: { [a]: 'restored' } })
		expect(await readFile(a, 'utf8')).toBe('v0')
		const status = (id: string) => store.previewUndo(id).then((p) => p.status)
		expect(await status(T1)).toBe('undone')
		expect(await status(T2)).toBe('undone')
	})

	it('undoes the newer reply and then the older one', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(store, T1, a, 'v1')
		await edit(store, T2, a, 'v2')
		await undoNow(store, T2)
		expect(await readFile(a, 'utf8')).toBe('v1')
		// T2 is undone, so it no longer stands in T1's way.
		const out = await undoNow(store, T1)
		expect(out.files).toEqual({ [a]: 'restored' })
		expect(await readFile(a, 'utf8')).toBe('v0')
	})

	it('reports a plan that moved and applies nothing', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(store, T1, a, 'v1')
		const shown = await store.previewUndo(T1)
		await writeFile(a, 'changed after the preview')
		const out = await store.undo(T1, { planToken: shown.planToken })
		expect(out.kind).toBe('plan-changed')
		const fresh = (out as { plan: UndoPreview }).plan
		expect(fresh.planToken).not.toBe(shown.planToken)
		expect(fresh.files[0]).toMatchObject({ action: 'conflict', reason: 'drifted' })
		expect(await readFile(a, 'utf8')).toBe('changed after the preview')
	})

	it('aborts a path whose file changed after the plan and before the write', async () => {
		const store = open({
			hooks: {
				beforeStep: async (path) => {
					await writeFile(path, 'raced in')
				},
			},
		})
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(store, T1, a, 'v1')
		const out = await undoNow(store, T1)
		expect(out.files).toEqual({ [a]: 'skipped' })
		expect(await readFile(a, 'utf8')).toBe('raced in')
		expect(out.status).toBe('applied')
	})

	it('is partly undone when the write of the second of three files fails, and a rerun finishes', async () => {
		let failing: string | undefined
		const store = open({
			hooks: {
				beforeWrite: (path) => {
					if (path === failing) throw new Error('disk full')
				},
			},
		})
		const files = ['one', 'two', 'three'].map((n) => join(cwd, `${n}.txt`))
		for (const f of files) await writeFile(f, 'v0')
		store.beginTurn('three files', T1)
		for (const f of files) await edit(store, T1, f, 'v1')

		failing = files[1]
		const first = await undoNow(store, T1)
		expect(first.files).toEqual({
			[files[0] as string]: 'restored',
			[files[1] as string]: 'failed',
			[files[2] as string]: 'restored',
		})
		expect(first.status).toBe('partially_undone')
		expect(await readFile(files[1] as string, 'utf8')).toBe('v1')

		failing = undefined
		const second = await undoNow(store, T1)
		expect(second.files).toEqual({
			[files[0] as string]: 'noop',
			[files[1] as string]: 'restored',
			[files[2] as string]: 'noop',
		})
		expect(second.status).toBe('undone')
		expect(await readFile(files[1] as string, 'utf8')).toBe('v0')
	})

	it('never writes a body that does not match its name', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(store, T1, a, 'v1')
		await writeFile(blobPath(historyRoot, hashBytes(Buffer.from('v0'))), 'tampered')
		const out = await undoNow(store, T1)
		expect(out.files).toEqual({ [a]: 'failed' })
		expect(await readFile(a, 'utf8')).toBe('v1')
	})

	it('leaves no temp file behind', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(store, T1, a, 'v1')
		await undoNow(store, T1)
		expect((await readdir(cwd)).filter((n) => n.endsWith('.tmp'))).toEqual([])
		expect((await readdir(join(historyRoot, 'turns'))).filter((n) => n.endsWith('.tmp'))).toEqual(
			[],
		)
	})

	it('serialises with a snapshot: one lands before the other, never inside it', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(store, T1, a, 'v1')
		const preview = await store.previewUndo(T1)
		const undoing = store.undo(T1, { planToken: preview.planToken })
		const snapping = store.snapshot(a, { turnId: T2 })
		expect((await undoing).kind).toBe('applied')
		expect(await snapping).toBe('recorded')
		const m = parseManifest(await readFile(manifestPath(historyRoot, T2), 'utf8'))
		expect(m?.entries[0]?.before?.sha256).toBe(hashBytes(Buffer.from('v0')))
	})
})

describe('retention', () => {
	it('expires a turn by age, says so, and still never lets release delete anything', async () => {
		const first = open({ maxAgeMs: 1000 })
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(first, T1, a, 'v1')
		await first.release()
		expect(await exists(manifestPath(historyRoot, T1))).toBe(true)

		clock += 5000
		const second = open({ maxAgeMs: 1000 })
		await second.open()
		const m = parseManifest(await readFile(manifestPath(historyRoot, T1), 'utf8'))
		expect(m?.pruned).toBe(true)
		expect(second.list()).toEqual([])
		await expect(second.previewUndo(T1)).rejects.toThrow(/expired/)
		// The bodies went with it.
		expect(await exists(blobPath(historyRoot, hashBytes(Buffer.from('v0'))))).toBe(false)
	})

	it('expires the oldest turns first when over the size cap', async () => {
		const first = open()
		const big = (n: number) => 'x'.repeat(n)
		const a = join(cwd, 'a.txt')
		await writeFile(a, big(100))
		await edit(first, T1, a, big(200))
		clock += 10
		await edit(first, T2, a, big(300))
		await first.release()

		// Bodies are shared: 100 + 200 + 300 in all. Over 500, T1 goes and T2's 200 + 300 fit.
		const second = open({ maxBytes: 500 })
		await second.open()
		const status = async (id: string) =>
			parseManifest(await readFile(manifestPath(historyRoot, id), 'utf8'))?.pruned === true
		expect(await status(T1)).toBe(true)
		expect(await status(T2)).toBe(false)
		expect(second.list().map((t) => t.turnId)).toEqual([T2])
	})

	it('keeps a body that a live turn still names when an expired turn shared it', async () => {
		const first = open({ maxAgeMs: 1000 })
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(first, T1, a, 'v1')
		clock += 5000
		await edit(first, T2, a, 'v2')
		await first.release()
		const second = open({ maxAgeMs: 1000 })
		await second.open()
		// v1 is T1's after and T2's before: T2 keeps it.
		expect(await exists(blobPath(historyRoot, hashBytes(Buffer.from('v1'))))).toBe(true)
		expect((await undoNow(second, T2)).files).toEqual({ [a]: 'restored' })
	})
})

describe('forks', () => {
	it('reference the parent turns up to the fork point and share their bodies', async () => {
		const parentRoot = join(cwd, 'parent', 'file-history')
		const parent = new FileCheckpointStore(parentRoot, cwd, { now: () => clock })
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(parent, T1, a, 'v1')
		await edit(parent, T2, a, 'v2')
		await parent.release()

		const child = open()
		expect(await child.adoptFork(parentRoot, { untilTurnId: T1 })).toBe(1)
		expect(child.list().map((t) => t.turnId)).toEqual([T1])
		const body = hashBytes(Buffer.from('v0'))
		expect((await readFile(blobPath(historyRoot, body))).toString()).toBe('v0')
		if (process.platform !== 'win32') {
			expect((await stat(blobPath(historyRoot, body))).ino).toBe(
				(await stat(blobPath(parentRoot, body))).ino,
			)
		}
		// Adopting again adds nothing.
		expect(await child.adoptFork(parentRoot, { untilTurnId: T1 })).toBe(0)
		await writeFile(a, 'v1')
		expect((await undoNow(child, T1)).files).toEqual({ [a]: 'restored' })
	})
})

describe('writing a manifest', () => {
	it('refuses a turn id that could name another path', async () => {
		await expect(
			writeManifest(historyRoot, {
				version: 1,
				turnId: '../escape',
				seq: 1,
				label: '',
				startedAt: 0,
				lastEditAt: 0,
				status: 'applied',
				entries: [],
				skipped: [],
				uncoveredShell: false,
			}),
		).rejects.toThrow(/Unsafe turn id/)
		expect(() => open().beginTurn('x', '../escape')).toThrow()
	})
})

describe('adversarial review', () => {
	it('keeps the bodies of a manifest it cannot read instead of calling them orphans', async () => {
		const first = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(first, T1, a, 'v1')
		await first.release()
		// A newer version's manifest names this body; this reader cannot see that.
		const sha = hashBytes(Buffer.from('v0'))
		const m = JSON.parse(await readFile(manifestPath(historyRoot, T1), 'utf8'))
		await writeFile(manifestPath(historyRoot, T1), JSON.stringify({ ...m, version: 2 }))
		const second = open()
		await second.open()
		expect(await exists(blobPath(historyRoot, sha))).toBe(true)
	})

	it('keeps the operator copy saved by an undo when retention expires the turn', async () => {
		const first = open({ maxAgeMs: 1000 })
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(first, T1, a, 'v1')
		await writeFile(a, 'mine')
		const out = await undoNow(first, T1, { resolutions: { [a]: 'keep_copy' } })
		const sha = out.copies[0]?.sha256 ?? ''
		await first.release()
		clock += 5000
		const second = open({ maxAgeMs: 1000 })
		await second.open()
		expect(await readFile(blobPath(historyRoot, sha), 'utf8')).toBe('mine')
	})

	it('does not undo a file under a later reply whose edit is still in flight', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		await edit(store, T1, a, 'v1')
		// T2 has snapshotted but its tool has not settled.
		await store.snapshot(a, { turnId: T2, tool: 'edit', toolUseId: 'c2' })
		const preview = await store.previewUndo(T1)
		expect(preview.files[0]).toMatchObject({ action: 'conflict', reason: 'later-reply' })
		expect((await undoNow(store, T1)).files).toEqual({ [a]: 'skipped' })
		expect(await readFile(a, 'utf8')).toBe('v1')
	})

	it('shows a turn that kept editing after being undone as partly undone', async () => {
		const store = open()
		const a = join(cwd, 'a.txt')
		const b = join(cwd, 'b.txt')
		await writeFile(a, 'v0')
		await writeFile(b, 'b0')
		await edit(store, T1, a, 'v1')
		await undoNow(store, T1)
		await store.snapshot(b, { turnId: T1, tool: 'edit', toolUseId: 'late' })
		await writeFile(b, 'b1')
		await store.settle(b, { ok: true, first: true, turnId: T1 })
		expect((await store.previewUndo(T1)).status).toBe('partially_undone')
		expect(store.list().map((t) => t.turnId)).toEqual([T1])
	})
})
