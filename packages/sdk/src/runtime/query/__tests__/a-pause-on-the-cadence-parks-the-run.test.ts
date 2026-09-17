import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { fixtureId } from '../../../test-support/ids.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { CheckpointSummary, HITLDecisionRequest } from '../../../types/hitl/index.js'
import type { IterationCheckpoint } from '../../../types/hitl/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { findPendingCheckpoint } from '../checkpoint.js'
import { type QueryParams, drainQuery } from '../index.js'
import { type ResumeRunParams, resumeRun } from '../resume-run.js'
import type { RunStateScope } from '../run-state.js'

/**
 * The `iteration_checkpoint` park is the one arm of the HITL union with no
 * test that ever builds an outstanding one.
 *
 * `hitl-answer-question.test.ts` covers the phase's decision handling, and
 * `resume-run.test.ts` covers `awaiting-decision` for a QUESTION park. What
 * nothing covered is the combination a slow-review host actually meets: the
 * cadence reaches a human, the human says "not now", and the run settles
 * PAUSED with a park still on the record that `resumeRun` will hand back
 * rather than step past.
 *
 * The card the human is shown rides on the same request, so the summary
 * projection is asserted here where it is actually delivered.
 */

const SCOPE: RunStateScope = {
	runId: fixtureId.run('cadence-pause'),
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

function oneToolTurn(): MockLLMProvider {
	return new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'a' } }], finishReason: 'tool_calls' },
			{ text: 'done' },
		],
	})
}

async function runUntilPaused(): Promise<{
	store: InMemoryCheckpointStore
	events: RunEvent[]
	run: Awaited<ReturnType<typeof drainQuery>>
	asked: HITLDecisionRequest[]
	workingDirectory: string
}> {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-cadence-pause-'))
	dirs.push(workingDirectory)
	const store = new InMemoryCheckpointStore()
	const events: RunEvent[] = []
	const asked: HITLDecisionRequest[] = []

	const run = await drainQuery(
		{
			provider: oneToolTurn(),
			tools: echoRegistry(),
			checkpointStore: store,
			agentId: 'agent_cadence_pause',
			agentName: 'Cadence pause agent',
			messages: [{ role: 'user', content: 'work' }],
			workingDirectory,
			runId: SCOPE.runId,
			tenantId: SCOPE.tenantId,
			projectId: SCOPE.projectId,
			sessionId: SCOPE.sessionId,
			topicId: SCOPE.topicId,
			authorizationGate: {
				enabled: true,
				rules: [{ type: 'allow_by_name', toolNames: ['echo'] }],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
			resumeHandler: async (request: HITLDecisionRequest) => {
				asked.push(request)
				// Only the cadence gate pauses. The tool review is approved so
				// the run reaches the phase under test.
				return request.type === 'iteration_checkpoint'
					? { action: 'pause', reason: 'not while I am reading this' }
					: { action: 'continue' }
			},
			runConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 6,
				maxResponseTokens: 256,
			},
		} as unknown as QueryParams,
		(event) => {
			events.push(event)
		},
	)

	return { store, events, run, asked, workingDirectory }
}

const outstanding = async (store: InMemoryCheckpointStore): Promise<IterationCheckpoint[]> =>
	(await store.listCheckpoints(SCOPE)).filter(
		(checkpoint) => checkpoint.pending && checkpoint.pending.resolvedAt === undefined,
	)

describe('a pause at the iteration checkpoint', () => {
	it('settles the run PAUSED rather than cancelling or failing it', async () => {
		const { run, events } = await runUntilPaused()

		// `paused` is not `cancelled`. A run paused at a checkpoint has a
		// checkpoint to come back to and was not stopped by anybody.
		expect(run.stopReason).toBe('paused')
		expect(events.some((event) => event.type === 'run_failed')).toBe(false)
		expect(events.some((event) => event.type === 'run_completed')).toBe(true)
		// PINNED, AND SURPRISING: `RunStatus` has no `paused` member, so a run
		// that parked at the cadence settles with `status: 'completed'` and
		// carries the pause only on `stopReason`. A host that reads `status`
		// alone cannot tell this run from one that answered — and
		// `deriveRunStatus` maps it to `succeeded`, because a terminal status
		// beats the outstanding park record. The refactor must not change this
		// in either direction; the shape is reported as a defect to fix on its
		// own track.
		expect(run.status).toBe('completed')
	})

	it('emits run_paused through the real loop, naming the checkpoint', async () => {
		const { events, store } = await runUntilPaused()

		const paused = events.filter(
			(event): event is Extract<RunEvent, { type: 'run_paused' }> => event.type === 'run_paused',
		)
		expect(paused).toHaveLength(1)
		expect(paused[0]?.reason).toBe('not while I am reading this')
		// The id is what a host puts in front of a person; a paused run whose
		// event does not name a checkpoint is a dead end.
		const parked = await outstanding(store)
		expect(paused[0]?.checkpointId).toBe(parked[0]?.id)
	})

	it('leaves a durable park behind, outstanding, of the cadence type', async () => {
		const { store } = await runUntilPaused()

		const parked = await outstanding(store)
		expect(parked).toHaveLength(1)
		expect(parked[0]?.pending?.request.type).toBe('iteration_checkpoint')
		// And it is findable through the read an approval queue is built from.
		expect((await findPendingCheckpoint(store, SCOPE))?.id).toBe(parked[0]?.id)
	})

	it('carries the summary a human is shown, with the usage as it stood', async () => {
		const { store, run } = await runUntilPaused()

		const parked = (await outstanding(store))[0]
		const request = parked?.pending?.request
		expect(request?.type).toBe('iteration_checkpoint')
		const summary = (request as { summary: CheckpointSummary }).summary

		// The card is built from the run at the moment it paused. The
		// iteration is the one the cadence fired on, and the token counts are
		// the run's — not zeros, which is what an unpopulated projection
		// would show a person asked to approve a run they cannot see.
		expect(summary.iteration).toBe(1)
		expect(summary.messageCount).toBeGreaterThan(0)
		expect(summary.tokenUsage.totalTokens).toBe(run.tokenUsage.totalTokens)
		expect(summary.costInfo.totalCost).toBe(run.costInfo.totalCost)
		// This turn ended with the model asking for a tool and saying
		// nothing, so there is no quote to show — absent, not blank.
		expect(summary.lastAssistantMessage).toBeUndefined()
	})
})

describe('resuming a run paused at the cadence', () => {
	it('hands the park back instead of stepping past it', async () => {
		const { store, asked, workingDirectory } = await runUntilPaused()
		const parked = (await outstanding(store))[0] as IterationCheckpoint

		const resumed = await resumeRun({
			scope: SCOPE,
			checkpointStore: store,
			// `ResumeRunParams` omits `runId` but keeps the rest of the
			// attribution, and the run state is projected from the SCOPE — so
			// a caller that leaves these out is refused rather than silently
			// resuming under somebody else's session.
			sessionId: SCOPE.sessionId,
			topicId: SCOPE.topicId,
			projectId: SCOPE.projectId,
			tenantId: SCOPE.tenantId,
			provider: oneToolTurn(),
			tools: echoRegistry(),
			agentId: 'agent_cadence_pause',
			agentName: 'Cadence pause agent',
			workingDirectory,
			runConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 6,
				maxResponseTokens: 256,
			},
		} as unknown as ResumeRunParams)

		expect(resumed.resumed).toBe(false)
		if (resumed.resumed) return
		expect(resumed.reason).toBe('awaiting-decision')
		if (resumed.reason !== 'awaiting-decision') return
		// The SAME request the human was already shown, so a queue reader
		// presents the decision that was actually asked for.
		expect(resumed.pending.request).toEqual(parked.pending?.request)
		expect(asked.some((request) => request.type === 'iteration_checkpoint')).toBe(true)
	})

	it('continues the same run, and leaves the answered park on the record', async () => {
		const { store, workingDirectory } = await runUntilPaused()
		// Read while it is still outstanding: after the resume the park is
		// resolved and this filter would be empty by design.
		const parked = (await outstanding(store))[0] as IterationCheckpoint

		const resumed = await resumeRun({
			scope: SCOPE,
			checkpointStore: store,
			sessionId: SCOPE.sessionId,
			topicId: SCOPE.topicId,
			projectId: SCOPE.projectId,
			tenantId: SCOPE.tenantId,
			// A host answering "go on" — the same park, now released.
			pendingDecision: { action: 'continue' },
			provider: oneToolTurn(),
			tools: echoRegistry(),
			agentId: 'agent_cadence_pause',
			agentName: 'Cadence pause agent',
			workingDirectory,
			runConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 6,
				maxResponseTokens: 256,
			},
		} as unknown as ResumeRunParams)

		expect(resumed.resumed).toBe(true)
		if (!resumed.resumed) return
		// Same run, same id — a resume is the same run under the same name.
		expect(resumed.run.id).toBe(SCOPE.runId)
		expect(resumed.run.status).toBe('completed')

		// FLIPPED 2026-09-18, by the commit that fixed what this used to pin.
		// The assertion here read `expect(stillOutstanding?.pending?.request.type)
		// .toBe('iteration_checkpoint')` and pinned the defect deliberately:
		// `planPendingResume` applies a decision only to a `tool_review` or
		// `user_question` park, so the `iteration_checkpoint` arm's decision was
		// honoured by the ordinary continue path and never RECORDED as resolved.
		// The consequence was not cosmetic — a FINISHED run kept reporting
		// `awaiting-decision` through `findPendingCheckpoint`, so a second
		// resume was refused for a decision already taken, and since `prune`
		// skips an unresolved park the row had become uncollectable. What is
		// asserted now is the resolution, with the same meaning "resolved" has
		// everywhere else: the record stays, and only its pending state ends.
		expect(await findPendingCheckpoint(store, SCOPE)).toBeNull()
		const recorded = (await store.listCheckpoints(SCOPE)).find(
			(checkpoint) => checkpoint.id === parked.id,
		)
		expect(recorded?.pending?.resolvedAt).toBeGreaterThan(0)
		expect(recorded?.pending?.decision).toMatchObject({ action: 'continue' })
		// The question that was asked is still on the record, so the evidence
		// a park exists to keep survives its answer.
		expect(recorded?.pending?.request).toEqual(parked.pending?.request)

		const again = await resumeRun({
			scope: SCOPE,
			checkpointStore: store,
			sessionId: SCOPE.sessionId,
			topicId: SCOPE.topicId,
			projectId: SCOPE.projectId,
			tenantId: SCOPE.tenantId,
			provider: oneToolTurn(),
			tools: echoRegistry(),
			agentId: 'agent_cadence_pause',
			agentName: 'Cadence pause agent',
			workingDirectory,
			runConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 6,
				maxResponseTokens: 256,
			},
		} as unknown as ResumeRunParams)
		// FLIPPED 2026-09-18 with the assertion above, and for the same
		// reason: this read `expect(again.reason).toBe('awaiting-decision')` —
		// the refusal a queue showed for a decision the human had already
		// given. With the park resolved there is nothing left to wait on, so
		// the resume proceeds. Whether this run has more work to do is not
		// this case's claim; the claim is that no unanswered question stands
		// in the way of asking.
		expect(again.resumed).toBe(true)
	})
})
