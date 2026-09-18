import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import type { RunPersistence } from '../../../manager/run/persistence.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { fixtureId } from '../../../test-support/ids.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { IterationCheckpoint } from '../../../types/hitl/index.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { CheckpointManager, findPendingCheckpoint } from '../checkpoint.js'
import { type ResumeRunParams, resumeRun } from '../resume-run.js'
import type { RunStateScope } from '../run-state.js'

/**
 * A park must not outlive the run it belongs to.
 *
 * `planPendingResume` covers the two arms whose decision has to REACH
 * something — the calls a `tool_review` park is about, the tool a
 * `user_question` park is inside — and the `iteration_checkpoint` arm was
 * resolved by the fix that taught the resume path to record a decision the
 * ordinary continue path carries out. The `plan_approval` arm was left out of
 * that set, so a run resumed with `{action: 'approve_plan'}` COMPLETED while
 * its park stayed outstanding.
 *
 * The harm is not cosmetic, and it is the same harm twice over: a finished run
 * keeps being served by `findPendingCheckpoint`, so a host that asks again is
 * told a human still owes this run an answer and a second resume is refused
 * `awaiting-decision`; and since `prune` skips an unresolved park, the row can
 * no longer be collected by anything the SDK has. Without a `hitlParkTtlMs`
 * there is no `deadlineAt` either, so `expire` cannot reach it.
 *
 * The park is PLANTED rather than produced by a live run, and that is
 * faithful, not convenient: the plan gate resolves its park on every decision
 * it receives, so the only way a `plan_approval` park outlives its process is
 * the one this write represents — a process that died while a human was
 * reading the plan, which is exactly what the eager `park()` before the await
 * exists for. The row is written by that same `CheckpointManager.park`.
 */

const SCOPE: RunStateScope = {
	runId: generateRunId(),
	tenantId: generateTenantId(),
	projectId: generateProjectId(),
	sessionId: generateSessionId(),
	topicId: generateTopicId(),
}

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const ZERO_COST = {
	inputCostPer1M: 0,
	outputCostPer1M: 0,
	totalCost: 0,
	cacheDiscount: 0,
	unpricedTokens: 0,
}
const ZERO_USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

function makeRunMgrStub(): RunPersistence {
	return {
		id: SCOPE.runId,
		messages: [{ role: 'user', content: 'the work I asked for' }],
		tokenUsage: { ...ZERO_USAGE },
		costInfo: { ...ZERO_COST },
		currentIteration: 1,
		getSession: () => ({ startedAt: Date.now() }),
	} as unknown as RunPersistence
}

function echoRegistry(): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register(
		defineTool({
			name: 'echo',
			description: 'echoes the text back',
			inputSchema: z.object({ text: z.string() }),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: 'hi' }),
		}),
	)
	return tools
}

/** The park a process leaves behind when it dies while a human is reading. */
async function plantPlanPark(store: InMemoryCheckpointStore): Promise<IterationCheckpoint> {
	const mgr = new CheckpointManager(store, SCOPE)
	const checkpoint = await mgr.create(makeRunMgrStub(), 0)
	return await mgr.park(checkpoint, {
		type: 'plan_approval',
		runId: SCOPE.runId,
		checkpointId: checkpoint.id,
		plan: {
			planId: fixtureId.plan('park'),
			title: 'the work',
			steps: [],
		},
	})
}

async function resumeWith(store: InMemoryCheckpointStore, workingDirectory: string) {
	return await resumeRun({
		scope: SCOPE,
		checkpointStore: store,
		sessionId: SCOPE.sessionId,
		topicId: SCOPE.topicId,
		projectId: SCOPE.projectId,
		tenantId: SCOPE.tenantId,
		pendingDecision: { action: 'approve_plan' },
		provider: new MockLLMProvider({ turns: [{ text: 'done' }] } as never),
		tools: echoRegistry(),
		agentId: 'agent_plan_park',
		agentName: 'Plan park agent',
		workingDirectory,
		runConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 4,
			maxResponseTokens: 256,
		},
	} as unknown as ResumeRunParams)
}

describe('a plan park and the run that answered it', () => {
	it('does not keep serving a park once the run has finished', async () => {
		const store = new InMemoryCheckpointStore()
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-plan-park-'))
		dirs.push(workingDirectory)
		const planted = await plantPlanPark(store)

		// The park is what a host is shown, and what a resume without an
		// answer is refused for. Both are the state the fix has to clear.
		expect((await findPendingCheckpoint(store, SCOPE))?.id).toBe(planted.id)

		const resumed = await resumeWith(store, workingDirectory)
		expect(resumed.resumed).toBe(true)
		if (!resumed.resumed) return
		expect(resumed.run.status).toBe('completed')

		// The run is over, so nothing is waiting on anybody.
		expect(await findPendingCheckpoint(store, SCOPE)).toBeNull()
	})

	it('keeps the record, with the answer the human gave on it', async () => {
		const store = new InMemoryCheckpointStore()
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-plan-park-'))
		dirs.push(workingDirectory)
		const planted = await plantPlanPark(store)

		await resumeWith(store, workingDirectory)

		// Resolved, not deleted: a checkpoint that shows both what was asked
		// and what was answered is the evidence trail an approval gate is
		// worth having.
		const row = await store.readCheckpoint(SCOPE, planted.id)
		expect(row?.pending?.resolvedAt).toBeDefined()
		expect(row?.pending?.decision).toMatchObject({ action: 'approve_plan' })
		expect(row?.pending?.request).toEqual(planted.pending?.request)
	})
})
