import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'

import { DiskCheckpointStore } from '../../../store/run/checkpoint-disk.js'
import type {
	CheckpointId,
	HITLDecisionRequest,
	IterationCheckpoint,
} from '../../../types/hitl/index.js'
import type { RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import type { CheckpointRunScope } from '../../../types/run/checkpoint-store.js'
import { RUN_STATE_VERSION, RunStateVersionError, parseRunState } from '../../../types/run/state.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import { ZERO_COST } from '../../../utils/cost.js'
import { CheckpointManager, findPendingCheckpoint } from '../checkpoint.js'
import { type RunStateScope, loadRunState } from '../run-state.js'

/**
 * A parked approval used to exist only as a suspended `await` inside one
 * process. Nothing on disk said a human owed the run an answer, so an
 * approval queue could not be rebuilt and a serverless host could not park
 * a run at all — the container that held the promise had to stay alive.
 */

const RUN_ID = 'run_durable' as RunId
let baseDir: string
let store: DiskCheckpointStore
let scope: RunStateScope

beforeEach(async () => {
	baseDir = await mkdtemp(join(tmpdir(), 'namzu-durable-'))
	store = new DiskCheckpointStore({ baseDir })
	scope = {
		tenantId: 'tnt_d' as TenantId,
		projectId: 'prj_d' as ProjectId,
		sessionId: 'ses_d' as SessionId,
		threadId: 'thd_d' as ThreadId,
		runId: RUN_ID,
	}
})

afterEach(async () => {
	await removeTempDirAsync(baseDir)
})

function checkpoint(id: string, iteration: number): IterationCheckpoint {
	return {
		id: id as CheckpointId,
		runId: RUN_ID,
		iteration,
		messages: [{ role: 'user', content: `turn ${iteration}` }],
		tokenUsage: {
			promptTokens: 10 * iteration,
			completionTokens: iteration,
			totalTokens: 11 * iteration,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		costInfo: { ...ZERO_COST },
		guardState: { iterationCount: iteration, elapsedMs: 1_000 * iteration },
		createdAt: 1_700_000_000_000 + iteration,
	}
}

const reviewRequest = (checkpointId: string): HITLDecisionRequest => ({
	type: 'tool_review',
	runId: RUN_ID,
	checkpointId: checkpointId as CheckpointId,
	toolCalls: [{ id: 'call_1', name: 'delete_row', input: { id: 42 }, isDestructive: true }],
})

describe('recording a park', () => {
	it('makes the outstanding decision readable from the store alone', async () => {
		const mgr = new CheckpointManager(store, scope as CheckpointRunScope)
		const cp = checkpoint('cp_1', 1)
		await store.writeCheckpoint(scope, cp)

		expect(await findPendingCheckpoint(store, scope)).toBeNull()

		await mgr.park(cp, reviewRequest('cp_1'))

		// A DIFFERENT reader — a fresh store over the same directory, i.e.
		// what a second process has.
		const fresh = new DiskCheckpointStore({ baseDir })
		const found = await findPendingCheckpoint(fresh, scope)
		expect(found?.id).toBe('cp_1')
		expect(found?.pending?.request.type).toBe('tool_review')
		expect(found?.pending?.parkedAt).toBeGreaterThan(0)
	})

	it('stops being outstanding once answered, and keeps the answer as evidence', async () => {
		const mgr = new CheckpointManager(store, scope as CheckpointRunScope)
		const cp = checkpoint('cp_1', 1)
		await store.writeCheckpoint(scope, cp)
		await mgr.park(cp, reviewRequest('cp_1'))

		await mgr.unpark('cp_1' as CheckpointId, { action: 'approve_tools' })

		expect(await findPendingCheckpoint(store, scope)).toBeNull()
		const stored = await store.readCheckpoint(scope, 'cp_1' as CheckpointId)
		// Not erased — a gate that cannot say what was approved is not an
		// audit trail.
		expect(stored?.pending?.decision).toEqual({ action: 'approve_tools' })
		expect(stored?.pending?.resolvedAt).toBeGreaterThan(0)
	})

	it('returns the newest outstanding park when several checkpoints exist', async () => {
		const mgr = new CheckpointManager(store, scope as CheckpointRunScope)
		for (const [id, n] of [
			['cp_1', 1],
			['cp_2', 2],
			['cp_3', 3],
		] as const) {
			await store.writeCheckpoint(scope, checkpoint(id, n))
		}
		await mgr.park(checkpoint('cp_1', 1), reviewRequest('cp_1'))
		await mgr.unpark('cp_1' as CheckpointId, { action: 'approve_tools' })
		await mgr.park(checkpoint('cp_3', 3), reviewRequest('cp_3'))

		expect((await findPendingCheckpoint(store, scope))?.id).toBe('cp_3')
	})

	it('unparking something that was never parked is a no-op, not a crash', async () => {
		const mgr = new CheckpointManager(store, scope as CheckpointRunScope)
		await store.writeCheckpoint(scope, checkpoint('cp_1', 1))
		expect(await mgr.unpark('cp_1' as CheckpointId, { action: 'approve_tools' })).toBeNull()
		expect(await mgr.unpark('cp_gone' as CheckpointId, { action: 'approve_tools' })).toBeNull()
	})
})

describe('loadRunState', () => {
	it('rebuilds a snapshot with no live run object', async () => {
		await store.writeCheckpoint(scope, checkpoint('cp_1', 1))
		await store.writeCheckpoint(scope, checkpoint('cp_2', 2))

		const state = await loadRunState(store, scope)

		expect(state).not.toBeNull()
		expect(state?.runId).toBe(RUN_ID)
		expect(state?.currentIteration).toBe(2)
		// Budgets are properties of the RUN, not of the process hosting it.
		expect(state?.elapsedMs).toBe(2_000)
		expect(state?.tokenUsage.totalTokens).toBe(22)
		expect(state?.checkpointId).toBe('cp_2')
	})

	it('prefers the outstanding park over the newest checkpoint', async () => {
		// "What is this run waiting on" is the question a resuming process
		// is actually asking.
		const mgr = new CheckpointManager(store, scope as CheckpointRunScope)
		await store.writeCheckpoint(scope, checkpoint('cp_1', 1))
		await store.writeCheckpoint(scope, checkpoint('cp_2', 2))
		await mgr.park(checkpoint('cp_1', 1), reviewRequest('cp_1'))

		const state = await loadRunState(store, scope)
		expect(state?.checkpointId).toBe('cp_1')
		expect(state?.pending?.request.type).toBe('tool_review')
	})

	it('returns null for a run that never checkpointed', async () => {
		// Rather than synthesizing a snapshot that would restart from zero
		// while claiming to be a continuation.
		expect(await loadRunState(store, scope)).toBeNull()
	})

	it('survives a JSON round trip', async () => {
		await store.writeCheckpoint(scope, checkpoint('cp_1', 1))
		const state = await loadRunState(store, scope)
		const revived = parseRunState(JSON.stringify(state))
		expect(revived).toEqual(state)
	})
})

describe('parseRunState', () => {
	it('refuses a snapshot from an incompatible version', () => {
		// A silent partial restore produces a run that looks healthy and has
		// lost its budgets.
		expect(() => parseRunState(JSON.stringify({ version: 99, runId: RUN_ID }))).toThrow(
			RunStateVersionError,
		)
	})

	it('refuses a snapshot with no version at all', () => {
		expect(() => parseRunState('{"runId":"run_x"}')).toThrow(RunStateVersionError)
		expect(() => parseRunState('null')).toThrow(RunStateVersionError)
	})

	it('accepts an object as well as a string', () => {
		const state = { version: RUN_STATE_VERSION, runId: RUN_ID }
		expect(parseRunState(state).runId).toBe(RUN_ID)
	})
})
