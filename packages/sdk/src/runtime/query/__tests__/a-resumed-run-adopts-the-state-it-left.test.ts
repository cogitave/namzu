import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { fixtureId } from '../../../test-support/ids.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { HITLDecisionRequest, IterationCheckpoint } from '../../../types/hitl/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { type QueryParams, drainQuery } from '../index.js'
import { type ResumeRunParams, resumeRun } from '../resume-run.js'
import type { RunStateScope } from '../run-state.js'

/**
 * Compaction's working state is the run's own record of what it was doing —
 * the task, the decisions, the failures. It is snapshotted onto every
 * checkpoint so a resumed run can carry it forward, and the ONE line that
 * adopts it back (`index.ts`, the `restoreWorkingState` block in the
 * `resumeFromCheckpoint` branch) had no test at either end.
 *
 * The reason that gap matters is written in the surrounding comment: without
 * the adoption the next compaction supersedes the prior summary with one
 * covering only post-resume activity, and the record of everything before
 * the resume is silently gone. The run keeps working; it just forgets.
 *
 * Both ends are asserted here through a real paused run and a real
 * `resumeRun`, because a hand-built manager proves the restore helper works
 * and nothing about whether anything calls it.
 */

const SCOPE: RunStateScope = {
	runId: fixtureId.run('working-state-adopt'),
	tenantId: generateTenantId(),
	projectId: generateProjectId(),
	sessionId: generateSessionId(),
	topicId: generateTopicId(),
}

const TASK = 'ship the release on Tuesday'

const COMPACTION = CompactionConfigSchema.parse({
	strategy: 'salience',
	contextWindowTokens: 16_000,
	keepRecentMessages: 2,
	clearToolResults: false,
	llmVerification: false,
})

const RUN_CONFIG = {
	model: 'mock-model',
	timeoutMs: 30_000,
	tokenBudget: 100_000,
	maxIterations: 6,
	maxResponseTokens: 256,
}

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

/** A read-only tool the gate approves, so the only park is the cadence one. */
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

/** Three tool turns, so a resumed run reaches a second checkpoint. */
function toolTurns(): MockLLMProvider {
	return new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'a' } }], finishReason: 'tool_calls' },
			{ toolCalls: [{ id: 'c2', name: 'echo', args: { text: 'b' } }], finishReason: 'tool_calls' },
			{ toolCalls: [{ id: 'c3', name: 'echo', args: { text: 'c' } }], finishReason: 'tool_calls' },
			{ text: 'done' },
		],
	})
}

const gate = {
	enabled: true,
	rules: [{ type: 'allow_by_name' as const, toolNames: ['echo'] }],
	allowReadOnlyTools: false,
	denyDangerousPatterns: false,
	logDecisions: false,
}

/** Run until the cadence pauses, and return the checkpoint it wrote. */
async function runUntilPaused(store: InMemoryCheckpointStore, workingDirectory: string) {
	await drainQuery(
		{
			provider: toolTurns(),
			tools: echoRegistry(),
			checkpointStore: store,
			compactionConfig: COMPACTION,
			agentId: 'agent_working_state',
			agentName: 'Working state agent',
			messages: [{ role: 'user', content: TASK }],
			workingDirectory,
			runId: SCOPE.runId,
			tenantId: SCOPE.tenantId,
			projectId: SCOPE.projectId,
			sessionId: SCOPE.sessionId,
			topicId: SCOPE.topicId,
			authorizationGate: gate,
			resumeHandler: async (request: HITLDecisionRequest) =>
				request.type === 'iteration_checkpoint'
					? { action: 'pause', reason: 'stop here for a moment' }
					: { action: 'continue' },
			runConfig: RUN_CONFIG,
		} as unknown as QueryParams,
		(_event: RunEvent) => {},
	)
}

describe('the working state a checkpoint snapshots', () => {
	it('records the operator task the run was given', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-working-state-'))
		dirs.push(workingDirectory)
		const store = new InMemoryCheckpointStore()

		await runUntilPaused(store, workingDirectory)

		const checkpoints = await store.listCheckpoints(SCOPE)
		const paused = checkpoints.filter((cp) => cp.pending) as IterationCheckpoint[]
		expect(paused).toHaveLength(1)
		// The write side of the pair, and the premise for the case below: a
		// checkpoint that carried nothing could not be adopted by anybody.
		expect(paused[0]?.workingState?.task).toBe(TASK)
	})
})

describe('a resumed run', () => {
	it('carries the working state forward into the checkpoints it writes', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-working-state-'))
		dirs.push(workingDirectory)
		const store = new InMemoryCheckpointStore()

		await runUntilPaused(store, workingDirectory)
		const before = (await store.listCheckpoints(SCOPE)).filter(
			(cp) => cp.pending,
		) as IterationCheckpoint[]
		const parked = before[0] as IterationCheckpoint

		const resumed = await resumeRun({
			scope: SCOPE,
			checkpointStore: store,
			sessionId: SCOPE.sessionId,
			topicId: SCOPE.topicId,
			projectId: SCOPE.projectId,
			tenantId: SCOPE.tenantId,
			pendingDecision: { action: 'continue' },
			provider: toolTurns(),
			tools: echoRegistry(),
			compactionConfig: COMPACTION,
			agentId: 'agent_working_state',
			agentName: 'Working state agent',
			workingDirectory,
			authorizationGate: gate,
			runConfig: RUN_CONFIG,
		} as unknown as ResumeRunParams)

		expect(resumed.resumed).toBe(true)
		if (!resumed.resumed) return

		// A checkpoint the RESUMED run wrote, not the one it came back
		// through. Its working state comes from the live manager, so it says
		// exactly whether the manager was given the earlier state.
		const after = (await store.listCheckpoints(SCOPE)).filter(
			(cp) => cp.id !== parked.id,
		) as IterationCheckpoint[]
		expect(after.length).toBeGreaterThan(0)
		const newest = after[after.length - 1] as IterationCheckpoint

		// Delete the adoption block and this is `''`: the resumed run gets a
		// fresh manager, the task it was working on is gone, and the next
		// compaction replaces the run's own summary with one that only covers
		// what happened after the restart.
		expect(newest.workingState?.task).toBe(TASK)
	})

	it('does not re-seed the state from a message, which only a fresh run does', async () => {
		// The negative control for "the state came from the checkpoint": a
		// resume passes no messages, so if the task is present it cannot have
		// come from `extractFromUserMessage`.
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-working-state-'))
		dirs.push(workingDirectory)
		const store = new InMemoryCheckpointStore()

		await runUntilPaused(store, workingDirectory)
		const parked = (
			(await store.listCheckpoints(SCOPE)).filter((cp) => cp.pending) as IterationCheckpoint[]
		)[0] as IterationCheckpoint
		// What the resumed run will be handed, asserted so the case below
		// cannot pass by the checkpoint having secretly carried a task the
		// resumed run re-derived.
		expect(parked.workingState?.task).toBe(TASK)

		const resumed = await resumeRun({
			scope: SCOPE,
			checkpointStore: store,
			sessionId: SCOPE.sessionId,
			topicId: SCOPE.topicId,
			projectId: SCOPE.projectId,
			tenantId: SCOPE.tenantId,
			pendingDecision: { action: 'continue' },
			provider: toolTurns(),
			tools: echoRegistry(),
			compactionConfig: COMPACTION,
			agentId: 'agent_working_state',
			agentName: 'Working state agent',
			workingDirectory,
			authorizationGate: gate,
			runConfig: RUN_CONFIG,
		} as unknown as ResumeRunParams)

		expect(resumed.resumed).toBe(true)
		if (!resumed.resumed) return
		// The same claim from the other side: `resumeRun` forces `messages: []`,
		// so no seeding pass ran, and the task above survived on the state
		// alone.
		expect(resumed.state.messages.some((m) => m.content === TASK)).toBe(true)

		const newest = (await store.listCheckpoints(SCOPE)).at(-1) as IterationCheckpoint
		expect(newest.workingState?.task).toBe(TASK)
	})
})
