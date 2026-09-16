import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type Run, RunDiskStore } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { DEFAULT_AGENT_WORKFLOW, type SubagentActivity } from '../activity.js'
import { listSavedOrchestrationRuns, liveOrchestrationRuns } from '../runs.js'

const PARENT_SESSION = 'b6b0f2a4-9c9a-4a4e-9b0e-1f2a3b4c5d6e'
const CHILD_SESSION = 'c7c1f3b5-ad0b-4b5f-8c1f-2a3b4c5d6e7f'
const PARENT_RUN = 'd8d2a4c6-be1c-4c6a-9d2a-3b4c5d6e7f80'
const CHILD_RUN_A = 'e9e3b5d7-cf2d-4d7b-ae3b-4c5d6e7f8091'
const CHILD_RUN_B = 'f0f4c6e8-d03e-4e8c-bf4c-5d6e7f8091a2'

function agent(
	input: Partial<SubagentActivity> & Pick<SubagentActivity, 'viewId'>,
): SubagentActivity {
	return {
		viewId: input.viewId,
		agentId: input.agentId ?? 'general-purpose',
		description: input.description ?? input.viewId,
		prompt: input.prompt ?? '',
		batchId: input.batchId ?? 'batch-1',
		workflowId: input.workflowId ?? 'run-1',
		workflowGroupId: input.workflowGroupId ?? 'group-1',
		phaseId: input.phaseId ?? 'phase-1',
		workflow: input.workflow ?? DEFAULT_AGENT_WORKFLOW,
		phase: input.phase ?? 'Work',
		phaseSequence: input.phaseSequence ?? 1,
		status: input.status ?? 'working',
		startedAt: input.startedAt ?? 0,
		transcript: input.transcript ?? [],
		...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
		...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
		...(input.replayed ? { replayed: true } : {}),
	}
}

describe('liveOrchestrationRuns', () => {
	it('groups by parent run id, joining phases in launch order and summing tokens', () => {
		const runs = liveOrchestrationRuns(
			[
				agent({
					viewId: 'a',
					workflowId: 'run-1',
					workflow: 'Auth refactor',
					phase: 'Explore',
					phaseSequence: 1,
					startedAt: 1_000,
					tokens: 40,
				}),
				agent({
					viewId: 'b',
					workflowId: 'run-1',
					workflow: 'Auth refactor',
					phase: 'Implement',
					phaseSequence: 2,
					startedAt: 2_000,
					status: 'completed',
					completedAt: 3_000,
					tokens: 60,
				}),
			],
			10_000,
		)

		expect(runs).toEqual([
			{
				id: 'run-1',
				name: 'Auth refactor',
				startedAt: 1_000,
				phases: ['Explore', 'Implement'],
				agentsDone: 1,
				agentsTotal: 2,
				tokensTotal: 100,
				elapsedMs: 9_000,
				live: true,
			},
		])
	})

	it('excludes a group every one of whose members has already settled', () => {
		// A finished run belongs to disk, where run.json is the record of fact —
		// not here, which would be a second, competing account of it.
		const runs = liveOrchestrationRuns(
			[agent({ viewId: 'a', workflowId: 'run-done', status: 'completed', completedAt: 500 })],
			1_000,
		)
		expect(runs).toEqual([])
	})

	it('excludes replayed rows even when their saved status was never terminal', () => {
		const runs = liveOrchestrationRuns(
			[agent({ viewId: 'a', workflowId: 'run-1', status: 'working', replayed: true })],
			1_000,
		)
		expect(runs).toEqual([])
	})

	it('reports the neutral default when no workflow label was ever set', () => {
		const runs = liveOrchestrationRuns([agent({ viewId: 'a', workflowId: 'run-1' })], 1_000)
		expect(runs[0]?.name).toBe(DEFAULT_AGENT_WORKFLOW)
	})
})

describe('listSavedOrchestrationRuns', () => {
	const dirs: string[] = []
	afterEach(() => {
		for (const dir of dirs.splice(0)) removeTempDir(dir)
	})

	async function sessionsRoot(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-orchestration-runs-'))
		dirs.push(dir)
		return join(dir, 'sessions')
	}

	async function persistChild(root: string, runId: string, run: Partial<Run>): Promise<void> {
		const store = new RunDiskStore({ baseDir: join(root, CHILD_SESSION, 'runs') })
		await store.initRun(runId, PARENT_RUN)
		await store.writeRunMeta({
			id: runId,
			status: 'completed',
			metadata: {
				agentId: 'reviewer',
				agentName: 'reviewer',
				config: { model: 'a-model', tokenBudget: 0 },
				provider: 'mock',
			},
			messages: [],
			tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
			costInfo: { totalCost: 0 },
			currentIteration: 1,
			startedAt: 0,
			parentRunId: PARENT_RUN,
			...run,
		} as unknown as Run)
	}

	it('groups children by parent run and names the row from the parent turn', async () => {
		const root = await sessionsRoot()
		const parentStore = new RunDiskStore({ baseDir: join(root, PARENT_SESSION, 'runs') })
		await parentStore.initRun(PARENT_RUN)
		await parentStore.writeMessages(
			{ messages: [{ role: 'user', content: '  Refactor the auth module  ' }] } as unknown as Run,
			1,
		)
		await persistChild(root, CHILD_RUN_A, {
			status: 'completed',
			startedAt: 1_000,
			endedAt: 2_000,
			tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } as never,
		})
		await persistChild(root, CHILD_RUN_B, {
			status: 'failed',
			startedAt: 1_500,
			endedAt: 2_500,
			tokenUsage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } as never,
		})

		const runs = await listSavedOrchestrationRuns({ sessionsRoot: root, sessionId: PARENT_SESSION })

		// Whitespace collapsed the way a conversation title collapses one, and
		// the parent turn stands in for a workflow label no saved child can
		// supply — see the doc comment on `listSavedOrchestrationRuns`.
		expect(runs).toEqual([
			{
				id: PARENT_RUN,
				name: 'Refactor the auth module',
				startedAt: 1_000,
				phases: ['Work'],
				agentsDone: 2,
				agentsTotal: 2,
				tokensTotal: 40,
				elapsedMs: 1_500,
				live: false,
			},
		])
	})

	it('reports the neutral default when the parent turn left no messages.json', async () => {
		const root = await sessionsRoot()
		await mkdir(join(root, PARENT_SESSION, 'runs', PARENT_RUN), { recursive: true })
		await persistChild(root, CHILD_RUN_A, { status: 'running', startedAt: 1_000 })

		const runs = await listSavedOrchestrationRuns({ sessionsRoot: root, sessionId: PARENT_SESSION })

		expect(runs).toHaveLength(1)
		expect(runs[0]?.name).toBe(DEFAULT_AGENT_WORKFLOW)
		expect(runs[0]?.agentsDone).toBe(0)
		expect(runs[0]?.agentsTotal).toBe(1)
	})

	it('reports no runs for a conversation that never delegated anything', async () => {
		const root = await sessionsRoot()
		const runs = await listSavedOrchestrationRuns({ sessionsRoot: root, sessionId: PARENT_SESSION })
		expect(runs).toEqual([])
	})
})
