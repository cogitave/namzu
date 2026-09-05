import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'
import { InvalidIdError } from '../../../utils/id.js'

import { DiskCheckpointStore } from '../../../store/run/checkpoint-disk.js'
import type {
	CheckpointId,
	HITLDecisionRequest,
	IterationCheckpoint,
} from '../../../types/hitl/index.js'
import type { RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import type { CheckpointRunScope } from '../../../types/run/checkpoint-store.js'
import { RUN_STATE_VERSION, RunStateVersionError, parseRunState } from '../../../types/run/state.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { ZERO_COST } from '../../../utils/cost.js'
import { CheckpointManager, findPendingCheckpoint } from '../checkpoint.js'
import { type RunStateScope, loadRunState } from '../run-state.js'

/**
 * A parked approval used to exist only as a suspended `await` inside one
 * process. Nothing on disk said a human owed the run an answer, so an
 * approval queue could not be rebuilt and a serverless host could not park
 * a run at all — the container that held the promise had to stay alive.
 */

const RUN_ID = '54bf5651-0b7b-443e-a3c6-05170fe66108' as RunId
let baseDir: string
let store: DiskCheckpointStore
let scope: RunStateScope

beforeEach(async () => {
	baseDir = await mkdtemp(join(tmpdir(), 'namzu-durable-'))
	store = new DiskCheckpointStore({ baseDir })
	scope = {
		tenantId: '56b14123-e653-4cef-ac96-21f2d79d9bbd' as TenantId,
		projectId: '38018058-7f48-4a66-8cac-67bc513451f4' as ProjectId,
		sessionId: '3bd5ef45-8a0c-4fe7-8b55-f4453d7d8e43' as SessionId,
		topicId: '78bd1b88-07a8-43ba-b3c1-cc02468a3781' as TopicId,
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
		const cp = checkpoint('62d8ff8a-122d-4369-8274-e1f1dc479c1c', 1)
		await store.writeCheckpoint(scope, cp)

		expect(await findPendingCheckpoint(store, scope)).toBeNull()

		await mgr.park(cp, reviewRequest('62d8ff8a-122d-4369-8274-e1f1dc479c1c'))

		// A DIFFERENT reader — a fresh store over the same directory, i.e.
		// what a second process has.
		const fresh = new DiskCheckpointStore({ baseDir })
		const found = await findPendingCheckpoint(fresh, scope)
		expect(found?.id).toBe('62d8ff8a-122d-4369-8274-e1f1dc479c1c')
		expect(found?.pending?.request.type).toBe('tool_review')
		expect(found?.pending?.parkedAt).toBeGreaterThan(0)
	})

	it('stops being outstanding once answered, and keeps the answer as evidence', async () => {
		const mgr = new CheckpointManager(store, scope as CheckpointRunScope)
		const cp = checkpoint('62d8ff8a-122d-4369-8274-e1f1dc479c1c', 1)
		await store.writeCheckpoint(scope, cp)
		await mgr.park(cp, reviewRequest('62d8ff8a-122d-4369-8274-e1f1dc479c1c'))

		await mgr.unpark('62d8ff8a-122d-4369-8274-e1f1dc479c1c' as CheckpointId, {
			action: 'approve_tools',
		})

		expect(await findPendingCheckpoint(store, scope)).toBeNull()
		const stored = await store.readCheckpoint(
			scope,
			'62d8ff8a-122d-4369-8274-e1f1dc479c1c' as CheckpointId,
		)
		// Not erased — a gate that cannot say what was approved is not an
		// audit trail.
		expect(stored?.pending?.decision).toEqual({ action: 'approve_tools' })
		expect(stored?.pending?.resolvedAt).toBeGreaterThan(0)
	})

	it('returns the newest outstanding park when several checkpoints exist', async () => {
		const mgr = new CheckpointManager(store, scope as CheckpointRunScope)
		for (const [id, n] of [
			['62d8ff8a-122d-4369-8274-e1f1dc479c1c', 1],
			['7802b395-981e-430a-86c7-058cb79dbaf9', 2],
			['c534c8ba-5d65-413c-8d53-0fcbbf1aa392', 3],
		] as const) {
			await store.writeCheckpoint(scope, checkpoint(id, n))
		}
		await mgr.park(
			checkpoint('62d8ff8a-122d-4369-8274-e1f1dc479c1c', 1),
			reviewRequest('62d8ff8a-122d-4369-8274-e1f1dc479c1c'),
		)
		await mgr.unpark('62d8ff8a-122d-4369-8274-e1f1dc479c1c' as CheckpointId, {
			action: 'approve_tools',
		})
		await mgr.park(
			checkpoint('c534c8ba-5d65-413c-8d53-0fcbbf1aa392', 3),
			reviewRequest('c534c8ba-5d65-413c-8d53-0fcbbf1aa392'),
		)

		expect((await findPendingCheckpoint(store, scope))?.id).toBe(
			'c534c8ba-5d65-413c-8d53-0fcbbf1aa392',
		)
	})

	it('unparking something that was never parked is a no-op, not a crash', async () => {
		const mgr = new CheckpointManager(store, scope as CheckpointRunScope)
		await store.writeCheckpoint(scope, checkpoint('62d8ff8a-122d-4369-8274-e1f1dc479c1c', 1))
		expect(
			await mgr.unpark('62d8ff8a-122d-4369-8274-e1f1dc479c1c' as CheckpointId, {
				action: 'approve_tools',
			}),
		).toBeNull()
		expect(
			await mgr.unpark('7c81157d-b597-49f9-b951-772a567ecdf2' as CheckpointId, {
				action: 'approve_tools',
			}),
		).toBeNull()
	})
})

describe('loadRunState', () => {
	it('rebuilds a snapshot with no live run object', async () => {
		await store.writeCheckpoint(scope, checkpoint('62d8ff8a-122d-4369-8274-e1f1dc479c1c', 1))
		await store.writeCheckpoint(scope, checkpoint('7802b395-981e-430a-86c7-058cb79dbaf9', 2))

		const state = await loadRunState(store, scope)

		expect(state).not.toBeNull()
		expect(state?.runId).toBe(RUN_ID)
		expect(state?.currentIteration).toBe(2)
		// Budgets are properties of the RUN, not of the process hosting it.
		expect(state?.elapsedMs).toBe(2_000)
		expect(state?.tokenUsage.totalTokens).toBe(22)
		expect(state?.checkpointId).toBe('7802b395-981e-430a-86c7-058cb79dbaf9')
	})

	it('prefers the outstanding park over the newest checkpoint', async () => {
		// "What is this run waiting on" is the question a resuming process
		// is actually asking.
		const mgr = new CheckpointManager(store, scope as CheckpointRunScope)
		await store.writeCheckpoint(scope, checkpoint('62d8ff8a-122d-4369-8274-e1f1dc479c1c', 1))
		await store.writeCheckpoint(scope, checkpoint('7802b395-981e-430a-86c7-058cb79dbaf9', 2))
		await mgr.park(
			checkpoint('62d8ff8a-122d-4369-8274-e1f1dc479c1c', 1),
			reviewRequest('62d8ff8a-122d-4369-8274-e1f1dc479c1c'),
		)

		const state = await loadRunState(store, scope)
		expect(state?.checkpointId).toBe('62d8ff8a-122d-4369-8274-e1f1dc479c1c')
		expect(state?.pending?.request.type).toBe('tool_review')
	})

	it('returns null for a run that never checkpointed', async () => {
		// Rather than synthesizing a snapshot that would restart from zero
		// while claiming to be a continuation.
		expect(await loadRunState(store, scope)).toBeNull()
	})

	it('survives a JSON round trip', async () => {
		await store.writeCheckpoint(scope, checkpoint('62d8ff8a-122d-4369-8274-e1f1dc479c1c', 1))
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
		expect(() => parseRunState('{"runId":"f4e0af37-43f7-48fd-82b0-f1b1c68881d3"}')).toThrow(
			RunStateVersionError,
		)
		expect(() => parseRunState('null')).toThrow(RunStateVersionError)
	})

	it('accepts an object as well as a string', () => {
		const state = { version: RUN_STATE_VERSION, runId: RUN_ID }
		expect(parseRunState(state).runId).toBe(RUN_ID)
	})

	it('coerces a version-1 snapshot: threadId becomes topicId', () => {
		const legacy = {
			version: 1,
			runId: RUN_ID,
			sessionId: '3bd5ef45-8a0c-4fe7-8b55-f4453d7d8e43',
			threadId: '78bd1b88-07a8-43ba-b3c1-cc02468a3781',
			projectId: '38018058-7f48-4a66-8cac-67bc513451f4',
			tenantId: '56b14123-e653-4cef-ac96-21f2d79d9bbd',
		}
		const revived = parseRunState(JSON.stringify(legacy))
		expect(revived.version).toBe(RUN_STATE_VERSION)
		expect((revived as unknown as { topicId?: unknown }).topicId).toBe(
			'78bd1b88-07a8-43ba-b3c1-cc02468a3781',
		)
		expect((revived as unknown as { threadId?: unknown }).threadId).toBeUndefined()
	})

	it.each([
		['runId', 'run_old'],
		['parentRunId', 'run_parent'],
		['sessionId', 'ses_old'],
		['projectId', 'prj_old'],
		['tenantId', 'tnt_old'],
		['topicId', 'top_old'],
		['checkpointId', 'cp_old'],
	])('refuses a prefixed %s without rewriting its recorded value', (field, value) => {
		const raw = { version: RUN_STATE_VERSION, [field]: value }
		expect(() => parseRunState(raw)).toThrow(InvalidIdError)
		expect(raw[field]).toBe(value)
	})

	it('refuses a snapshot whose topic id carries the retired thd_ prefix, rather than rewriting it', () => {
		// The pre-0.2 container prefix. A reader that rewrote it would be
		// deciding what a record means on the writer's behalf; it refuses and
		// names the way out instead.
		const v1 = { version: 1, runId: RUN_ID, threadId: 'thd_d' }
		expect(() => parseRunState(JSON.stringify(v1))).toThrow(InvalidIdError)
		const v2 = { version: 2, runId: RUN_ID, topicId: 'thd_d' }
		expect(() => parseRunState(JSON.stringify(v2))).toThrow(InvalidIdError)
		const current = { version: RUN_STATE_VERSION, runId: RUN_ID, topicId: 'thd_d' }
		expect(() => parseRunState(JSON.stringify(current))).toThrow(InvalidIdError)
	})

	it('coerces a version-1 snapshot with no threadId without stamping a stray topicId', () => {
		const legacy = { version: 1, runId: RUN_ID }
		const revived = parseRunState(JSON.stringify(legacy))
		expect(revived.version).toBe(RUN_STATE_VERSION)
		// toEqual would forgive an unconditionally-added `topicId: undefined`;
		// the `in` check does not, which is the whole point of this assertion.
		expect('topicId' in revived).toBe(false)
	})

	it('coerces a version-2 snapshot with no topicId without stamping a stray field', () => {
		const v2 = { version: 2, runId: RUN_ID }
		const revived = parseRunState(JSON.stringify(v2))
		expect(revived.version).toBe(RUN_STATE_VERSION)
		expect('topicId' in revived).toBe(false)
	})

	it.each(['030c4c5d-1987-40b7-b197-bb1860fab281', '5985bc78-64b1-438b-972f-96d5dc0c5af0'])(
		'preserves topic ID %s through current and legacy snapshot reads',
		(topicId) => {
			const current = {
				version: RUN_STATE_VERSION,
				runId: RUN_ID,
				topicId,
			}
			const revived = parseRunState(JSON.stringify(current))
			expect(revived).toEqual(current)
			expect(parseRunState({ ...current, version: 2 })).toEqual(current)
			expect(parseRunState({ version: 1, runId: RUN_ID, threadId: topicId })).toEqual(current)
		},
	)
})
