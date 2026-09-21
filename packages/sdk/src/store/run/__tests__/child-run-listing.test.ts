import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import type { Run } from '../../../types/run/entity.js'
import { RunDiskStore } from '../disk.js'

/**
 * `addToIndex` returns early for any run carrying a `parentRunId`, so the
 * browsable catalogue has never listed a delegated child — which is correct,
 * because a child is not a conversation anyone resumes. The consequence
 * nobody intended is that the evidence a child writes unprompted had no
 * reader: every file was on disk and nothing could name it. These tests pin
 * both halves at once, because a later change that "fixes" the listing by
 * dropping the guard would pass any test written about only the second.
 */

const PARENT = '5f8a9f2b-9f0d-4a1e-9e1d-0f0a2b3c4d5e'
const CHILD = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const SIBLING = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'

const LOG = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn(() => LOG),
}

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
})

async function baseDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-children-'))
	dirs.push(dir)
	return dir
}

function run(id: string, over: Partial<Run> = {}): Run {
	return {
		id,
		status: 'completed',
		metadata: {
			agentId: 'reviewer',
			agentName: 'reviewer',
			config: { model: 'a-model', tokenBudget: 0 },
			provider: 'mock',
		},
		messages: [],
		tokenUsage: { promptTokens: 40, completionTokens: 60, totalTokens: 100 },
		costInfo: { totalCost: 0 },
		currentIteration: 1,
		startedAt: 1_000,
		endedAt: 2_000,
		...over,
	} as unknown as Run
}

/** Exactly what the runtime writes for a delegated child, in the same order. */
async function writeChild(base: string, childId: string, over: Partial<Run> = {}): Promise<void> {
	const store = new RunDiskStore({ baseDir: base, logger: LOG })
	await store.initRun(childId, PARENT)
	const record = run(childId, { parentRunId: PARENT, depth: 1, ...over } as Partial<Run>)
	await store.writeRunMeta(record)
	await store.addToIndex(record)
}

describe('delegated children on disk', () => {
	it('listChildren returns children the index deliberately omits', async () => {
		const base = await baseDir()
		const parent = new RunDiskStore({ baseDir: base, logger: LOG })
		await parent.initRun(PARENT)
		const parentRun = run(PARENT, { metadata: run(PARENT).metadata })
		await parent.writeRunMeta(parentRun)
		await parent.addToIndex(parentRun)

		await writeChild(base, CHILD)
		await writeChild(base, SIBLING, { startedAt: 1_500, status: 'failed' } as Partial<Run>)

		// The catalogue still answers "which conversations are there", and a
		// delegated child is still not one of them.
		const listed = await RunDiskStore.listRuns(base)
		expect(listed.map((entry) => entry.id)).toEqual([PARENT])

		const children = await RunDiskStore.listChildren(base, PARENT)
		expect(children.map((child) => child.id)).toEqual([CHILD, SIBLING])
		expect(children[0]).toEqual({
			id: CHILD,
			parentRunId: PARENT,
			dir: join(base, PARENT, 'children', CHILD),
			agentId: 'reviewer',
			agentName: 'reviewer',
			model: 'a-model',
			status: 'completed',
			startedAt: 1_000,
			endedAt: 2_000,
			totalTokens: 100,
			depth: 1,
		})
		expect(children[1]?.status).toBe('failed')
	})

	it('is empty for a run with no children', async () => {
		const base = await baseDir()
		const parent = new RunDiskStore({ baseDir: base, logger: LOG })
		await parent.initRun(PARENT)
		await parent.writeRunMeta(run(PARENT))

		expect(await RunDiskStore.listChildren(base, PARENT)).toEqual([])
		// And for a parent that was never written at all — an absent directory
		// is "no children", never an error.
		expect(await RunDiskStore.listChildren(base, SIBLING)).toEqual([])
	})

	it('ignores a directory with no run.json', async () => {
		const base = await baseDir()
		await writeChild(base, CHILD)
		// A child killed before its terminal write, and a stray file beside the
		// child directories. Neither becomes a listing row; the surviving
		// child still does.
		await mkdir(join(base, PARENT, 'children', SIBLING), { recursive: true })
		await writeFile(join(base, PARENT, 'children', SIBLING, 'transcript.jsonl'), '', 'utf-8')
		await writeFile(join(base, PARENT, 'children', 'notes.txt'), 'stray', 'utf-8')

		const children = await RunDiskStore.listChildren(base, PARENT)
		expect(children.map((child) => child.id)).toEqual([CHILD])
	})

	it('ignores a child whose run.json is not readable JSON', async () => {
		const base = await baseDir()
		await writeChild(base, CHILD)
		await mkdir(join(base, PARENT, 'children', SIBLING), { recursive: true })
		await writeFile(join(base, PARENT, 'children', SIBLING, 'run.json'), '{"id":', 'utf-8')

		const children = await RunDiskStore.listChildren(base, PARENT)
		expect(children.map((child) => child.id)).toEqual([CHILD])
	})
})

describe('the deprecated run catalogue', () => {
	it('is read from each run record, so a run nobody indexed is still listed', async () => {
		const base = await baseDir()
		const parent = new RunDiskStore({ baseDir: base, logger: LOG })
		await parent.initRun(PARENT)
		// Only the run record: the kernel no longer calls addToIndex.
		await parent.writeRunMeta(run(PARENT))
		await writeChild(base, CHILD)

		expect(existsSync(join(base, 'index.json'))).toBe(false)
		expect(await RunDiskStore.listRuns(base)).toEqual([
			{
				id: PARENT,
				agentId: 'reviewer',
				agentName: 'reviewer',
				model: 'a-model',
				status: 'completed',
				startedAt: 1_000,
				endedAt: 2_000,
				iterations: 1,
				totalTokens: 100,
			},
		])
	})
})
