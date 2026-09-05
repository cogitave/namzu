import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileCheckpointStore, renderCheckpoints, renderRestore } from '../store.js'

let cwd: string
let store: FileCheckpointStore

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), 'namzu-ckpt-'))
	store = new FileCheckpointStore(
		join(cwd, '.namzu', 'checkpoints', 'fea5c0c7-1d0f-46cc-9844-c3a8f90afede'),
		cwd,
	)
})

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true })
})

const exists = (p: string) =>
	stat(p).then(
		() => true,
		() => false,
	)

describe('a restore', () => {
	it('puts a changed file back and removes a created one', async () => {
		const a = join(cwd, 'a.txt')
		const b = join(cwd, 'b.txt')
		await writeFile(a, 'one')
		store.beginTurn('change a, create b')
		expect(await store.snapshot('a.txt')).toBe('recorded')
		await writeFile(a, 'two')
		expect(await store.snapshot(b)).toBe('recorded')
		await writeFile(b, 'new')

		const report = await store.restore(1)
		expect(await readFile(a, 'utf8')).toBe('one')
		expect(await exists(b)).toBe(false)
		expect(report.restored).toEqual([a])
		expect(report.removed).toEqual([b])
		expect(store.list()).toEqual([])
		expect(renderRestore(report, cwd)).toBe(
			'Restored the tree to before turn 1.\n  restored a.txt\n  removed  b.txt',
		)
	})

	it('keeps the first snapshot of a turn, and reaches the oldest state across turns', async () => {
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'v0')
		store.beginTurn('turn one')
		await store.snapshot(a)
		await writeFile(a, 'v1')
		expect(await store.snapshot(a)).toBe('already')
		await writeFile(a, 'v1b')
		store.beginTurn('turn two')
		await store.snapshot(a)
		await writeFile(a, 'v2')

		expect(renderCheckpoints(store.list(), cwd)).toContain(
			'  1. turn one\n       a.txt\n  2. turn two',
		)
		await store.restore(2)
		expect(await readFile(a, 'utf8')).toBe('v1b')
		expect(store.list().map((t) => t.index)).toEqual([1])
		await store.restore(1)
		expect(await readFile(a, 'utf8')).toBe('v0')
	})

	it('ignores files outside the working directory and turns with no writes', async () => {
		store.beginTurn('nothing')
		expect(await store.snapshot('/etc/hostname')).toBe('outside')
		expect(await store.snapshot('../sibling.txt')).toBe('outside')
		expect(store.list()).toEqual([])
		expect(renderCheckpoints(store.list(), cwd)).toContain('No checkpoints')
		await expect(store.restore(1)).rejects.toThrow(/No checkpoint for turn 1/)
	})

	it('drops its blobs when the session closes', async () => {
		const a = join(cwd, 'a.txt')
		await writeFile(a, 'x')
		store.beginTurn('t')
		await store.snapshot(a)
		expect(
			await exists(join(cwd, '.namzu', 'checkpoints', 'fea5c0c7-1d0f-46cc-9844-c3a8f90afede', '1')),
		).toBe(true)
		await store.close()
		expect(
			await exists(join(cwd, '.namzu', 'checkpoints', 'fea5c0c7-1d0f-46cc-9844-c3a8f90afede')),
		).toBe(false)
	})
})
