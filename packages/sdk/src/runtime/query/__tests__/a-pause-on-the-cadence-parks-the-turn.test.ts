import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { Toolset } from '../../../toolsets/types.js'
import type { CheckpointSummary, HITLDecisionRequest } from '../../../types/hitl/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import { generateTurnId } from '../../../utils/id.js'
import { type RecordedPark, findPendingCheckpoint, readParks } from '../checkpoint.js'
import { type QueryParams, drainQuery } from '../index.js'
import { type ResumeSessionParams, resumeSession } from '../resume-session.js'
import type { TurnStateScope } from '../turn-state.js'
import { heldCheckpointStore, memorySession } from './support/session.js'

/**
 * The `iteration_checkpoint` park is the one arm of the HITL union with no
 * test that ever builds an outstanding one.
 *
 * `hitl-answer-question.test.ts` covers the phase's decision handling, and
 * `resume-turn.test.ts` covers `awaiting-decision` for a QUESTION park. What
 * nothing covered is the combination a slow-review host actually meets: the
 * cadence reaches a human, the human says "not now", and the turn settles
 * PAUSED with a park still on the record that `resumeSession` will hand back
 * rather than step past.
 *
 * The card the human is shown rides on the same request, so the summary
 * projection is asserted here where it is actually delivered.
 */

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

/** A read-only tool the gate approves, so the only park is the cadence one. */
function echoToolset(): Toolset {
	return testToolset(
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
	session: ReturnType<typeof memorySession>
	scope: TurnStateScope
	events: SessionEvent[]
	run: Awaited<ReturnType<typeof drainQuery>>
	asked: HITLDecisionRequest[]
	workingDirectory: string
}> {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-cadence-pause-'))
	dirs.push(workingDirectory)
	const session = memorySession()
	const scope: TurnStateScope = {
		turnId: generateTurnId(),
		tenantId: session.tenantId,
		projectId: session.projectId,
		sessionId: session.sessionId,
		topicId: session.topicId,
	}
	const events: SessionEvent[] = []
	const asked: HITLDecisionRequest[] = []

	const run = await drainQuery(
		{
			provider: oneToolTurn(),
			toolsets: [echoToolset()],
			...session,
			agentId: 'agent_cadence_pause',
			agentName: 'Cadence pause agent',
			messages: [{ role: 'user', content: 'work' }],
			workingDirectory,
			turnId: scope.turnId,
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
				// the turn reaches the phase under test.
				return request.type === 'iteration_checkpoint'
					? { action: 'pause', reason: 'not while I am reading this' }
					: { action: 'continue' }
			},
			turnConfig: {
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

	return { session, scope, events, run, asked, workingDirectory }
}

const outstanding = async (session: ReturnType<typeof memorySession>): Promise<RecordedPark[]> =>
	(await readParks(session.sessionLog)).filter((park) => park.pending.resolvedAt === undefined)

/** The resume a host would issue for the paused turn. */
async function resumeParamsFor(
	{ session, scope, workingDirectory }: Awaited<ReturnType<typeof runUntilPaused>>,
	extra: Record<string, unknown> = {},
): Promise<ResumeSessionParams> {
	return {
		scope,
		sessionLog: session.sessionLog,
		checkpointStore: await heldCheckpointStore(session.sessionLog),
		sessionId: scope.sessionId,
		topicId: scope.topicId,
		projectId: scope.projectId,
		tenantId: scope.tenantId,
		provider: oneToolTurn(),
		toolsets: [echoToolset()],
		agentId: 'agent_cadence_pause',
		agentName: 'Cadence pause agent',
		workingDirectory,
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 6,
			maxResponseTokens: 256,
		},
		...extra,
	} as unknown as ResumeSessionParams
}

describe('a pause at the iteration checkpoint', () => {
	it('settles the turn PAUSED rather than cancelling or failing it', async () => {
		const { run, events } = await runUntilPaused()

		// `paused` is not `cancelled`. A turn paused at a checkpoint has a
		// checkpoint to come back to and was not stopped by anybody.
		expect(run.stopReason).toBe('paused')
		expect(events.some((event) => event.type === 'turn_failed')).toBe(false)
		// A paused turn is not settled: `turn_paused` ends its segment, and no
		// terminal record closes it, so `resumeSession` can continue it.
		expect(events.some((event) => event.type === 'turn_paused')).toBe(true)
		expect(events.some((event) => event.type === 'turn_completed')).toBe(false)
		// The returned object still says `completed` and carries the pause on
		// `stopReason`: `TurnExecutionStatus` has no `paused` member.
		expect(run.status).toBe('completed')
	})

	it('emits turn_paused through the real loop, naming the checkpoint', async () => {
		const { events, session } = await runUntilPaused()

		const paused = events.filter(
			(event): event is Extract<SessionEvent, { type: 'turn_paused' }> =>
				event.type === 'turn_paused',
		)
		expect(paused).toHaveLength(1)
		expect(paused[0]?.reason).toBe('not while I am reading this')
		// The id is what a host puts in front of a person; a paused turn whose
		// event does not name a checkpoint is a dead end.
		const parked = await outstanding(session)
		expect(paused[0]?.checkpointId).toBe(parked[0]?.checkpointId)
	})

	it('leaves a durable park behind, outstanding, of the cadence type', async () => {
		const { session } = await runUntilPaused()

		const parked = await outstanding(session)
		expect(parked).toHaveLength(1)
		expect(parked[0]?.pending.request.type).toBe('iteration_checkpoint')
		// And it is findable through the read an approval queue is built from.
		expect((await findPendingCheckpoint(session.sessionLog))?.checkpointId).toBe(
			parked[0]?.checkpointId,
		)
	})

	it('carries the summary a human is shown, with the usage as it stood', async () => {
		const { session, run } = await runUntilPaused()

		const parked = (await outstanding(session))[0]
		const request = parked?.pending.request
		expect(request?.type).toBe('iteration_checkpoint')
		const summary = (request as { summary: CheckpointSummary }).summary

		// The card is built from the turn at the moment it paused. The
		// iteration is the one the cadence fired on, and the token counts are
		// the turn's — not zeros, which is what an unpopulated projection
		// would show a person asked to approve a turn they cannot see.
		expect(summary.iteration).toBe(1)
		expect(summary.messageCount).toBeGreaterThan(0)
		expect(summary.tokenUsage.totalTokens).toBe(run.tokenUsage.totalTokens)
		expect(summary.costInfo.totalCost).toBe(run.costInfo.totalCost)
		// This turn ended with the model asking for a tool and saying
		// nothing, so there is no quote to show — absent, not blank.
		expect(summary.lastAssistantMessage).toBeUndefined()
	})
})

describe('resuming a turn paused at the cadence', () => {
	it('hands the park back instead of stepping past it', async () => {
		const paused = await runUntilPaused()
		const parked = (await outstanding(paused.session))[0] as RecordedPark

		const resumed = await resumeSession(await resumeParamsFor(paused))

		expect(resumed.resumed).toBe(false)
		if (resumed.resumed) return
		expect(resumed.reason).toBe('awaiting-decision')
		if (resumed.reason !== 'awaiting-decision') return
		// The SAME request the human was already shown, so a queue reader
		// presents the decision that was actually asked for.
		expect(resumed.pending.request).toEqual(parked.pending.request)
		expect(paused.asked.some((request) => request.type === 'iteration_checkpoint')).toBe(true)
	})

	it('continues the same turn, and leaves the answered park on the record', async () => {
		const paused = await runUntilPaused()
		// Read while it is still outstanding: after the resume the park is
		// resolved and this filter would be empty by design.
		const parked = (await outstanding(paused.session))[0] as RecordedPark

		const resumed = await resumeSession(
			await resumeParamsFor(paused, { pendingDecision: { action: 'continue' } }),
		)

		expect(resumed.resumed).toBe(true)
		if (!resumed.resumed) return
		// Same turn, same id — a resume is the same turn under the same name.
		expect(resumed.turn.id).toBe(paused.scope.turnId)
		expect(resumed.turn.status).toBe('completed')

		// The park is resolved: the record stays, and only its pending state
		// ends, so a finished turn stops reporting `awaiting-decision`.
		expect(await findPendingCheckpoint(paused.session.sessionLog)).toBeNull()
		const recorded = (await readParks(paused.session.sessionLog)).find(
			(park) => park.checkpointId === parked.checkpointId,
		)
		expect(recorded?.pending.resolvedAt).toBeGreaterThan(0)
		expect(recorded?.pending.decision).toMatchObject({ action: 'continue' })
		// The question that was asked is still on the record.
		expect(recorded?.pending.request).toEqual(parked.pending.request)

		// The turn settled, so there is nothing left to resume: a settled turn
		// is refused rather than reopened. `resumeSession` catches this itself
		// now, before claiming a lease under the dead turn's id; `query()`'s
		// own `assertTurnMayStart` still refuses it too, deeper in, if
		// something ever reaches it a different way.
		await expect(resumeSession(await resumeParamsFor(paused))).rejects.toThrow(
			/already ended; a completed or failed turn's checkpoint cannot be resumed/,
		)
	})
})
