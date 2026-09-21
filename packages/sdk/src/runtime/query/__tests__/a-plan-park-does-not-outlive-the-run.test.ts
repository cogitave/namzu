import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { fixtureId } from '../../../test-support/ids.js'
import { defineTool } from '../../../tools/defineTool.js'
import { CheckpointManager, findPendingCheckpoint, readParks } from '../checkpoint.js'
import { type ResumeSessionParams, resumeSession } from '../resume-session.js'
import {
	type CheckpointedSession,
	TEST_SCOPE,
	checkpointRecords,
	sessionWithCheckpoint,
} from './support/session.js'

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
 * The park is PLANTED rather than produced by a live turn, and that is
 * faithful, not convenient: the plan gate resolves its park on every decision
 * it receives, so the only way a `plan_approval` park outlives its process is
 * the one this write represents — a process that died while a human was
 * reading the plan. The record is written by that same `CheckpointManager.park`.
 */

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

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
async function plantPlanPark(): Promise<CheckpointedSession> {
	const session = await sessionWithCheckpoint({
		messages: [{ role: 'user', content: 'the work I asked for' }],
	})
	const manager = new CheckpointManager(checkpointRecords(session), session.store, session.scope)
	await manager.park(
		{ id: session.checkpointId },
		{
			type: 'plan_approval',
			sessionId: session.sessionId,
			turnId: session.turnId,
			checkpointId: session.checkpointId,
			plan: { planId: fixtureId.plan('park'), title: 'the work', steps: [] },
		},
	)
	// The process dies: its lease lapses, and the turn reads as interrupted.
	await session.log.release(session.lease)
	return session
}

async function resumeWith(session: CheckpointedSession, workingDirectory: string) {
	return await resumeSession({
		scope: { ...session.scope, topicId: TEST_SCOPE.topicId },
		sessionLog: session.log,
		checkpointStore: session.store,
		sessionId: session.sessionId,
		topicId: TEST_SCOPE.topicId,
		projectId: session.scope.projectId,
		tenantId: session.scope.tenantId,
		pendingDecision: { action: 'approve_plan' },
		provider: new MockLLMProvider({ turns: [{ text: 'done' }] } as never),
		tools: echoRegistry(),
		agentId: 'agent_plan_park',
		agentName: 'Plan park agent',
		workingDirectory,
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 4,
			maxResponseTokens: 256,
		},
	} as unknown as ResumeSessionParams)
}

describe('a plan park and the turn that answered it', () => {
	it('does not keep serving a park once the turn has finished', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-plan-park-'))
		dirs.push(workingDirectory)
		const planted = await plantPlanPark()

		// The park is what a host is shown, and what a resume without an
		// answer is refused for. Both are the state the fix has to clear.
		expect((await findPendingCheckpoint(planted.log))?.checkpointId).toBe(planted.checkpointId)

		const resumed = await resumeWith(planted, workingDirectory)
		expect(resumed.resumed).toBe(true)
		if (!resumed.resumed) return
		expect(resumed.turn.status).toBe('completed')

		// The turn is over, so nothing is waiting on anybody.
		expect(await findPendingCheckpoint(planted.log)).toBeNull()
	})

	it('keeps the record, with the answer the human gave on it', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-plan-park-'))
		dirs.push(workingDirectory)
		const planted = await plantPlanPark()
		const asked = (await readParks(planted.log))[0]

		await resumeWith(planted, workingDirectory)

		// Resolved, not deleted: the log shows both what was asked and what
		// was answered, the evidence trail an approval gate is worth having.
		const row = (await readParks(planted.log)).find(
			(park) => park.checkpointId === planted.checkpointId,
		)
		expect(row?.pending.resolvedAt).toBeDefined()
		expect(row?.pending.decision).toMatchObject({ action: 'approve_plan' })
		expect(row?.pending.request).toEqual(asked?.pending.request)
	})
})
