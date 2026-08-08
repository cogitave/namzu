import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'

import type { CheckpointId, IterationCheckpoint } from '../../types/hitl/index.js'
import type { RunId } from '../../types/ids/index.js'
import { RunDiskStore } from '../run/disk.js'

/**
 * A checkpoint file is the ONLY durable record of a park — there is no
 * separate approval store. So an unreadable one that gets logged and
 * skipped does not merely lose a resume point: `findPendingCheckpoint`
 * reports "not parked" and drops an approval a human already granted.
 *
 * The listing path swallowed every per-file failure and returned a short
 * list that four callers treat as complete. A missing newest checkpoint
 * quietly resumes from an older one and re-runs a whole iteration of tool
 * calls; pruning under-deletes, because a file the keep-count cannot see is
 * immortal. The by-id read next door was already strict — two read paths
 * disagreeing about whether damage matters is how the lenient one gets
 * trusted.
 */

const RUN_ID = 'run_cp' as RunId

let baseDir: string
let store: RunDiskStore
let cpDir: string

beforeEach(async () => {
	baseDir = mkdtempSync(join(tmpdir(), 'namzu-cp-'))
	store = new RunDiskStore({ baseDir })
	const runDir = await store.initRun(RUN_ID)
	cpDir = join(runDir, 'checkpoints')
	// The store creates this on first write; these tests plant files in it.
	mkdirSync(cpDir, { recursive: true })
})

afterEach(() => {
	removeTempDir(baseDir)
})

function checkpoint(id: string, iteration: number): IterationCheckpoint {
	return {
		id: id as CheckpointId,
		runId: RUN_ID,
		iteration,
		messages: [],
		tokenUsage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		costInfo: {
			inputCost: 0,
			outputCost: 0,
			totalCost: 0,
			inputCostPer1M: 0,
			outputCostPer1M: 0,
			cacheDiscount: 0,
		},
		guardState: { iterationCount: iteration, elapsedMs: 0 },
		createdAt: 1_000 + iteration,
	} as IterationCheckpoint
}

describe('a damaged checkpoint', () => {
	it('is refused rather than skipped when listing', async () => {
		await store.writeCheckpoint(checkpoint('cp_1', 1))
		writeFileSync(join(cpDir, 'cp_2.json'), '{ not json', 'utf-8')

		await expect(store.listCheckpoints()).rejects.toThrow()
	})

	it('does not quietly shorten the list', async () => {
		await store.writeCheckpoint(checkpoint('cp_1', 1))
		await store.writeCheckpoint(checkpoint('cp_2', 2))
		expect(await store.listCheckpoints()).toHaveLength(2)

		writeFileSync(join(cpDir, 'cp_2.json'), 'truncated', 'utf-8')
		// Returning one here is the failure: the caller cannot tell it from
		// a run that only ever had one checkpoint.
		await expect(store.listCheckpoints()).rejects.toThrow()
	})

	it('is refused on the by-id path too', async () => {
		writeFileSync(join(cpDir, 'cp_9.json'), '{ not json', 'utf-8')
		await expect(store.readCheckpoint('cp_9' as CheckpointId)).rejects.toThrow()
	})
})

describe('a file that parses but is not a checkpoint', () => {
	it('is refused rather than resumed from', async () => {
		writeFileSync(join(cpDir, 'cp_empty.json'), '{}', 'utf-8')
		// This used to pass both read paths — a cast is not a check — and
		// fail much later at the point of use, where the message names a
		// missing property rather than a damaged file.
		await expect(store.listCheckpoints()).rejects.toThrow(/not a usable checkpoint/)
	})

	it('names the file and what a resume needs', async () => {
		writeFileSync(join(cpDir, 'cp_partial.json'), JSON.stringify({ id: 'x' }), 'utf-8')
		await expect(store.readCheckpoint('cp_partial' as CheckpointId)).rejects.toThrow(
			/cp_partial\.json/,
		)
	})
})

describe('the ordinary paths', () => {
	it('still lists what is there, oldest first', async () => {
		await store.writeCheckpoint(checkpoint('cp_2', 2))
		await store.writeCheckpoint(checkpoint('cp_1', 1))

		expect((await store.listCheckpoints()).map((c) => c.id)).toEqual(['cp_1', 'cp_2'])
	})

	it('returns an empty list when there are no checkpoints at all', async () => {
		// Absent is not damaged, and must stay distinguishable from it.
		expect(await store.listCheckpoints()).toEqual([])
	})

	it('returns null for a checkpoint that was never written', async () => {
		expect(await store.readCheckpoint('cp_missing' as CheckpointId)).toBeNull()
	})

	it('ignores files that are not checkpoints', async () => {
		await store.writeCheckpoint(checkpoint('cp_1', 1))
		writeFileSync(join(cpDir, 'notes.txt'), 'scratch', 'utf-8')
		expect(await store.listCheckpoints()).toHaveLength(1)
	})
})
