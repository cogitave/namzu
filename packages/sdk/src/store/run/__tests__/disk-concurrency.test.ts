// Current-code invariants asserted (2026-07-13, ses_017 post-review F1):
//
// - `atomicWriteFile` used a FIXED `${filePath}.tmp`. Two writers to one path — two
//   `RunDiskStore` instances, two processes, or simply two `updateCheckpoint` calls
//   that the per-instance lock does not span — raced on that one temp name: A writes
//   the temp, B overwrites it, A renames it away, and B's rename dies with
//   `ENOENT: rename('run.json.tmp' -> 'run.json')`. On the decision path that surfaced
//   as an opaque 500 where the errors contract promised a `DecisionAlreadyResolvedError`.
//   The temp name is now unique per write.
// - `claimDecision` is the durable compare-and-set the single-use token rests on: an
//   exclusive create that exactly one caller can win, across store instances and across
//   processes, because the filesystem — not a Map on an object — arbitrates it.
import { mkdtempSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import type { CheckpointId, IterationCheckpoint } from '../../../types/hitl/index.js'
import type { RunId } from '../../../types/ids/index.js'
import type { Run } from '../../../types/run/index.js'
import { ZERO_COST } from '../../../utils/cost.js'
import { RunDiskStore } from '../disk.js'

const RUN_ID = 'run_concurrency' as RunId
const CP_ID = 'cp_concurrency' as CheckpointId

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'namzu-run-store-'))
}

function run(): Run {
	return {
		id: RUN_ID,
		status: 'running',
		metadata: {
			agentId: 'a',
			agentName: 'A',
			config: { model: 'm', tokenBudget: 1, timeoutMs: 1 },
			provider: 'p',
		},
		messages: [],
		tokenUsage: { ...EMPTY_TOKEN_USAGE },
		costInfo: { ...ZERO_COST },
		currentIteration: 0,
		startedAt: 1,
	}
}

function checkpoint(): IterationCheckpoint {
	return {
		id: CP_ID,
		runId: RUN_ID,
		iteration: 1,
		messages: [],
		tokenUsage: { ...EMPTY_TOKEN_USAGE },
		costInfo: { ...ZERO_COST },
		guardState: { iterationCount: 1, elapsedMs: 0 },
		createdAt: 1,
	}
}

async function storeAt(baseDir: string): Promise<RunDiskStore> {
	const store = new RunDiskStore({ baseDir })
	await store.initRun(RUN_ID)
	return store
}

describe('RunDiskStore — concurrent writers to one path', () => {
	it('does not collide on a shared temp file', async () => {
		const baseDir = tmp()

		// Sixteen independent stores — the shape `resumeDecision` actually has, since it
		// builds a fresh store per call — all writing the same `run.json`.
		const stores = await Promise.all(Array.from({ length: 16 }, () => storeAt(baseDir)))

		await expect(Promise.all(stores.map((s) => s.writeRunMeta(run())))).resolves.toBeDefined()

		const meta = await stores[0]?.readRunMeta()
		expect(meta?.id).toBe(RUN_ID)

		// And no temp file is left behind to be read as a run record by anything walking
		// the directory.
		const files = await readdir(join(baseDir, RUN_ID))
		expect(files.filter((f) => f.includes('.tmp'))).toEqual([])
	})
})

describe('RunDiskStore.claimDecision — the durable compare-and-set', () => {
	it('exactly one of N concurrent claimants wins, and the losers see the winner’s claim', async () => {
		const baseDir = tmp()
		const stores = await Promise.all(Array.from({ length: 8 }, () => storeAt(baseDir)))
		await stores[0]?.writeCheckpoint(checkpoint())

		const results = await Promise.all(
			stores.map((s, i) =>
				s.claimDecision(CP_ID, {
					requestId: 'dreq_1' as never,
					claimedBy: `caller_${i}`,
					at: Date.now(),
					outcome: { action: 'approve_tools' },
				}),
			),
		)

		// `null` means "you won". Everyone else is handed the winner's claim — the record
		// that says what the decision was answered with, available even before the winner
		// has finished writing it onto the checkpoint.
		const winners = results.filter((r) => r === null)
		const losers = results.filter((r) => r !== null)
		expect(winners).toHaveLength(1)
		expect(losers).toHaveLength(7)
		for (const loser of losers) {
			expect(loser?.outcome).toEqual({ action: 'approve_tools' })
			expect(loser?.claimedBy).toMatch(/^caller_\d$/)
		}
		// Every loser saw the SAME winner.
		expect(new Set(losers.map((l) => l?.claimedBy)).size).toBe(1)
	})

	it('a claim survives a fresh store — it is on disk, not in memory', async () => {
		const baseDir = tmp()
		const first = await storeAt(baseDir)
		await first.writeCheckpoint(checkpoint())
		expect(
			await first.claimDecision(CP_ID, {
				requestId: 'dreq_1' as never,
				at: 1,
				outcome: { action: 'approve_tools' },
			}),
		).toBeNull()

		const second = await storeAt(baseDir)
		const lost = await second.claimDecision(CP_ID, {
			requestId: 'dreq_1' as never,
			at: 2,
			outcome: { action: 'reject_tools', feedback: 'no' },
		})
		expect(lost?.outcome).toEqual({ action: 'approve_tools' })
	})

	it('does not put the claim where listCheckpoints will read it as a checkpoint', async () => {
		const baseDir = tmp()
		const store = await storeAt(baseDir)
		await store.writeCheckpoint(checkpoint())
		await store.claimDecision(CP_ID, { requestId: 'dreq_1' as never, at: 1 })

		const listed = await store.listCheckpoints()
		expect(listed).toHaveLength(1)
		expect(listed[0]?.id).toBe(CP_ID)
	})
})
