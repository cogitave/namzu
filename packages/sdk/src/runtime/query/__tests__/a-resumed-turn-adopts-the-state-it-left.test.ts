import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { fixtureId } from '../../../test-support/ids.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { HITLDecisionRequest } from '../../../types/hitl/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { readParks } from '../checkpoint.js'
import { type QueryParams, drainQuery } from '../index.js'
import { type ResumeSessionParams, resumeSession } from '../resume-session.js'
import type { TurnStateScope } from '../turn-state.js'
import { heldCheckpointStore, turnCheckpoints } from './support/session.js'

/**
 * Compaction's working state is the turn's own record of what it was doing —
 * the task, the decisions, the failures. It is snapshotted onto every
 * checkpoint so a resumed turn can carry it forward, and the ONE line that
 * adopts it back (`index.ts`, the `restoreWorkingState` block in the
 * `resumeFromCheckpoint` branch) had no test at either end.
 *
 * The reason that gap matters is written in the surrounding comment: without
 * the adoption the next compaction supersedes the prior summary with one
 * covering only post-resume activity, and the record of everything before
 * the resume is silently gone. The turn keeps working; it just forgets.
 *
 * Both ends are asserted here through a real paused turn and a real
 * `resumeSession`, because a hand-built manager proves the restore helper works
 * and nothing about whether anything calls it.
 */

const SCOPE: TurnStateScope = {
	turnId: fixtureId.turn('working-state-adopt'),
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

/** Three tool turns, so a resumed turn reaches a second checkpoint. */
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

/**
 * Run until the cadence pauses. Returns the session log and the checkpoint
 * the park names.
 */
async function runUntilPaused(workingDirectory: string) {
	const sessionLog = new InMemorySessionLog({ sessionId: SCOPE.sessionId })
	await drainQuery(
		{
			provider: toolTurns(),
			tools: echoRegistry(),
			sessionLog,
			compactionConfig: COMPACTION,
			agentId: 'agent_working_state',
			agentName: 'Working state agent',
			messages: [{ role: 'user', content: TASK }],
			workingDirectory,
			turnId: SCOPE.turnId,
			tenantId: SCOPE.tenantId,
			projectId: SCOPE.projectId,
			sessionId: SCOPE.sessionId,
			topicId: SCOPE.topicId,
			authorizationGate: gate,
			resumeHandler: async (request: HITLDecisionRequest) =>
				request.type === 'iteration_checkpoint'
					? { action: 'pause', reason: 'stop here for a moment' }
					: { action: 'continue' },
			turnConfig: RUN_CONFIG,
		} as unknown as QueryParams,
		(_event: SessionEvent) => {},
	)
	const store = await heldCheckpointStore(sessionLog)
	const parks = await readParks(sessionLog, { turnId: SCOPE.turnId })
	const parked = await Promise.all(parks.map((park) => store.read({ ...SCOPE }, park.checkpointId)))
	return { sessionLog, store, parks, parked }
}

describe('the working state a checkpoint snapshots', () => {
	it('records the operator task the turn was given', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-working-state-'))
		dirs.push(workingDirectory)
		const { parks, parked: paused } = await runUntilPaused(workingDirectory)

		expect(parks).toHaveLength(1)
		expect(paused).toHaveLength(1)
		// The write side of the pair, and the premise for the case below: a
		// checkpoint that carried nothing could not be adopted by anybody.
		expect(paused[0]?.workingState?.task).toBe(TASK)
	})
})

describe('a resumed turn', () => {
	it('carries the working state forward into the checkpoints it writes', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-working-state-'))
		dirs.push(workingDirectory)
		const { sessionLog, store, parked: before } = await runUntilPaused(workingDirectory)
		const parked = before[0]
		if (!parked) throw new Error('no parked checkpoint')

		const resumed = await resumeSession({
			scope: SCOPE,
			sessionLog,
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
			turnConfig: RUN_CONFIG,
		} as unknown as ResumeSessionParams)

		expect(resumed.resumed).toBe(true)
		if (!resumed.resumed) return

		// A checkpoint the RESUMED run wrote, not the one it came back
		// through. Its working state comes from the live manager, so it says
		// exactly whether the manager was given the earlier state.
		const after = (await turnCheckpoints({ ...SCOPE, sessionLog })).filter(
			(cp) => cp.checkpointId !== parked.checkpointId,
		)
		expect(after.length).toBeGreaterThan(0)
		const newest = after[after.length - 1]

		// Delete the adoption block and this is `''`: the resumed turn gets a
		// fresh manager, the task it was working on is gone, and the next
		// compaction replaces the turn's own summary with one that only covers
		// what happened after the restart.
		expect(newest?.workingState?.task).toBe(TASK)
	})

	it('does not re-seed the state from a message, which only a fresh turn does', async () => {
		// The negative control for "the state came from the checkpoint": a
		// resume passes no messages, so if the task is present it cannot have
		// come from `extractFromUserMessage`.
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-working-state-'))
		dirs.push(workingDirectory)
		const { sessionLog, store, parked: paused } = await runUntilPaused(workingDirectory)
		const parked = paused[0]
		// What the resumed turn will be handed, asserted so the case below
		// cannot pass by the checkpoint having secretly carried a task the
		// resumed turn re-derived.
		expect(parked?.workingState?.task).toBe(TASK)

		const resumed = await resumeSession({
			scope: SCOPE,
			sessionLog,
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
			turnConfig: RUN_CONFIG,
		} as unknown as ResumeSessionParams)

		expect(resumed.resumed).toBe(true)
		if (!resumed.resumed) return
		// The same claim from the other side: `resumeSession` forces `messages: []`,
		// so no seeding pass ran, and the task above survived on the state
		// alone.
		expect(resumed.state.messages.some((m) => m.content === TASK)).toBe(true)

		const newest = (await turnCheckpoints({ ...SCOPE, sessionLog })).at(-1)
		expect(newest?.workingState?.task).toBe(TASK)
	})
})
