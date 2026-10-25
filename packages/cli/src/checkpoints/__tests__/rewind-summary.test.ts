import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { REWIND_STATS_MAX_EDITS } from '../rewind-stats.js'
import { FileCheckpointStore } from '../store.js'

let cwd: string
let store: FileCheckpointStore
let clock: number

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), 'namzu-rewind-'))
	clock = 0
	store = new FileCheckpointStore(
		join(cwd, '.namzu', 'checkpoints', 'fea5c0c7-1d0f-46cc-9844-c3a8f90afede'),
		cwd,
	)
})

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true })
})

async function edit(path: string, body: string | Buffer, first = true) {
	await store.snapshot(path)
	await writeFile(path, body)
	await store.settle(path, { ok: true, first })
}

describe('which prompt a turn began with', () => {
	it('keeps the position of the prompt on the turn', async () => {
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'one\n')
		store.beginTurn('change a', undefined, { promptOrdinal: 4 })
		await edit(a, 'two\n')
		expect(store.list()[0]).toMatchObject({ label: 'change a', promptOrdinal: 4 })
	})

	it('leaves it absent when the caller gave none', async () => {
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'one\n')
		store.beginTurn('change a')
		await edit(a, 'two\n')
		expect(store.list()[0]?.promptOrdinal).toBeUndefined()
	})
})

describe('what a rewind would change', () => {
	it('counts lines added and removed for created, modified and deleted files', async () => {
		const mod = join(cwd, 'mod.txt')
		const gone = join(cwd, 'gone.txt')
		const made = join(cwd, 'made.txt')
		await writeFile(mod, 'a\nb\nc\n')
		await writeFile(gone, 'x\ny\n')
		store.beginTurn('everything')
		await edit(mod, 'a\nB\nc\nd\n')
		await store.snapshot(gone)
		await rm(gone)
		await store.settle(gone, { ok: true, first: true })
		await edit(made, '1\n2\n3\n')

		const summary = await store.rewindSummary(1)
		expect([...summary.files].sort()).toEqual([gone, made, mod].sort())
		// mod: +2 (B, d) -1 (b); gone: -2; made: +3
		expect(summary.insertions).toBe(5)
		expect(summary.deletions).toBe(3)
	})

	it('spans several turns: the first body before, the last body after', async () => {
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'one\n')
		store.beginTurn('t1')
		await edit(a, 'two\n')
		store.beginTurn('t2')
		await edit(a, 'three\nfour\n')

		expect(await store.rewindSummary(1)).toMatchObject({ files: [a], insertions: 2, deletions: 1 })
		// From the second turn on, the file went from "two" to "three four".
		expect(await store.rewindSummary(2)).toMatchObject({ files: [a], insertions: 2, deletions: 1 })
	})

	it('leaves out a file that ended up as it began', async () => {
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'one\n')
		store.beginTurn('t1')
		await edit(a, 'two\n')
		store.beginTurn('t2')
		await edit(a, 'one\n')
		const summary = await store.rewindSummary(1)
		expect(summary.files).toEqual([])
		expect(summary.insertions).toBe(0)
	})

	it('names the files but gives no line counts for a binary body', async () => {
		const bin = join(cwd, 'blob.bin')
		await writeFile(bin, Buffer.from([1, 2, 0, 3]))
		store.beginTurn('binary')
		await edit(bin, Buffer.from([9, 0, 9]))
		const summary = await store.rewindSummary(1)
		expect(summary.files).toEqual([bin])
		expect(summary.insertions).toBeUndefined()
		expect(summary.deletions).toBeUndefined()
	})

	it('names the files but gives no line counts past the edit cap', async () => {
		const big = join(cwd, 'big.txt')
		const before = Array.from({ length: REWIND_STATS_MAX_EDITS + 50 }, (_, i) => `a${i}`).join('\n')
		const after = Array.from({ length: REWIND_STATS_MAX_EDITS + 50 }, (_, i) => `b${i}`).join('\n')
		await writeFile(big, before)
		store.beginTurn('rewrite')
		await edit(big, after)
		const summary = await store.rewindSummary(1)
		expect(summary.files).toEqual([big])
		expect(summary.insertions).toBeUndefined()
	})

	it('stops counting when the clock says the budget is spent, and still names the files', async () => {
		const a = join(cwd, 'a.txt')
		const b = join(cwd, 'b.txt')
		await writeFile(a, '1\n')
		await writeFile(b, '1\n')
		store.beginTurn('two files')
		await edit(a, '2\n')
		await edit(b, '2\n')
		let calls = 0
		const summary = await store.rewindSummary(1, () => {
			calls += 1
			clock += 600
			return clock >= 1000
		})
		expect([...summary.files].sort()).toEqual([a, b].sort())
		expect(summary.insertions).toBeUndefined()
		expect(calls).toBeGreaterThan(0)
	})

	it('ignores turns already undone', async () => {
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'one\n')
		store.beginTurn('t1')
		await edit(a, 'two\n')
		await store.restore(1)
		expect((await store.rewindSummary(1)).files).toEqual([])
	})
})
