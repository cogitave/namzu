import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../../__fixtures__/temp-dir.js'

import { CompletionInbox } from '../../../../gateway/completion-inbox.js'
import { ToolRegistry } from '../../../../registry/tool/execute.js'
import { DELEGATION_TIMEOUT_MS } from '../../../../tools/coordinator/index.js'
import type { TaskHandle } from '../../../../types/agent/gateway.js'
import type { SessionId, TaskId, TenantId } from '../../../../types/ids/index.js'
import { createUserMessage } from '../../../../types/message/index.js'
import type { LLMProvider, StreamChunk } from '../../../../types/provider/index.js'
import type { ProjectId, ThreadId } from '../../../../types/session/ids.js'
import { GuardCoordinator } from '../../guard.js'
import { drainQuery } from '../../index.js'
import { settleGraceMs } from '../index.js'

/**
 * How long a finishing run waits for a worker it launched.
 *
 * This used to be a constant — 120 seconds, unrelated to the run holding it.
 * Measured before the change: a run configured `timeoutMs: 20_000` was held
 * open for 120,267 ms, because the hold sits INSIDE an iteration and the guard
 * only checks between them, so nothing could interrupt it. The same constant
 * abandoned workers observed at 4m21s, 5m58s and 8m04s on runs that had hours
 * left.
 */

describe('the grace is a share of what the run has left', () => {
	it('takes half, so the turn that reads the result still has time to happen', () => {
		// The fraction is the whole argument. Spending everything remaining
		// would deliver a notification into a run with no turn left to act on
		// it — the failure this mechanism exists to prevent, in a new costume.
		expect(settleGraceMs(60_000)).toBe(30_000)
	})

	it('holds for nothing when the run has nothing left', () => {
		// A decision, not a rounding artefact: with no time left there is no
		// turn in which to read a notification, so waiting can only delay a
		// stop that is already due. Nothing is lost — `waitForArrival` returns
		// before it looks at its timer when a completion is already in hand.
		expect(settleGraceMs(0)).toBe(0)
	})

	it('cannot outlive the deadline it was derived from', () => {
		// Bounded by construction, which is why the guard's inability to
		// interrupt a hold needs no new interrupt seam.
		for (const remaining of [1, 250, 30_000, 600_000, 3_600_000]) {
			expect(settleGraceMs(remaining)).toBeLessThan(remaining)
		}
	})

	it('stops at the longest this subsystem ever waits for a worker', () => {
		// Only reachable for a host whose run timeout exceeds two hours.
		expect(settleGraceMs(10 * 60 * 60 * 1000)).toBe(DELEGATION_TIMEOUT_MS)
	})
})

describe('the guard reports time to the finalize point, not to the deadline', () => {
	it('stops short of the closing reserve', () => {
		// 90% of the budget, not 100%. The last tenth is what the guard keeps
		// so a run can produce a closing answer; a wait sized against the
		// deadline spends it on waiting instead.
		const guard = new GuardCoordinator({ tokenBudget: 1_000, timeoutMs: 60_000 })

		const remaining = guard.remainingBeforeFinalizeMs()

		expect(remaining).toBeLessThanOrEqual(54_000)
		expect(remaining).toBeGreaterThan(50_000)
	})

	it('subtracts the time a previous process already spent', () => {
		// A run resumed from a checkpoint gets the remainder of ITS budget, not
		// a fresh clock — otherwise N resumes buy N x timeoutMs, and a hold
		// sized from the fresh clock would outlive the real deadline.
		const guard = new GuardCoordinator({ tokenBudget: 1_000, timeoutMs: 60_000 })
		guard.restoreElapsed(50_000)

		expect(guard.remainingBeforeFinalizeMs()).toBeLessThanOrEqual(4_000)
		expect(guard.remainingBeforeFinalizeMs()).toBeGreaterThan(1_000)
	})

	it('reports nothing once the run is already past the finalize point', () => {
		// 95% elapsed: the guard is about to ask for a closing summary, and a
		// hold opened here would be taken out of the answer's time.
		const guard = new GuardCoordinator({ tokenBudget: 1_000, timeoutMs: 60_000 })
		guard.restoreElapsed(57_000)

		expect(guard.remainingBeforeFinalizeMs()).toBe(0)
	})

	it('never reports a negative remainder', () => {
		const guard = new GuardCoordinator({ tokenBudget: 1_000, timeoutMs: 1_000 })
		guard.restoreElapsed(500_000)

		expect(guard.remainingBeforeFinalizeMs()).toBe(0)
	})
})

describe('the hold cannot reach into the run closing reserve', () => {
	it('ends before the finalize point however late it starts', () => {
		// The failure the finalize-relative input exists for. Against the
		// DEADLINE, a hold beginning at elapsed fraction e ends at
		// 0.5 + 0.5e — so one starting just under the 0.9 threshold ends at
		// 95% of the budget, with half the closing reserve gone. Against the
		// finalize point it cannot cross 90% at all.
		const timeoutMs = 60_000
		const finalizeAt = timeoutMs * 0.9

		for (const elapsed of [0, 30_000, 50_000, 53_000, 53_900]) {
			const remainingBeforeFinalize = Math.max(0, finalizeAt - elapsed)
			const endsAt = elapsed + settleGraceMs(remainingBeforeFinalize)

			expect(
				endsAt,
				`a hold starting at ${elapsed}ms crossed the finalize point`,
			).toBeLessThanOrEqual(finalizeAt)
		}
	})
})

const ZERO_USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

/** Answers straight away. The hold is the only thing that can delay this run. */
class AnswersImmediately implements LLMProvider {
	readonly id = 'answers'
	readonly name = 'Answers Immediately'
	async *chatStream(): AsyncIterable<StreamChunk> {
		yield { id: 'm1', delta: { content: 'Done.' } }
		yield { id: 'm1', delta: {}, finishReason: 'stop', usage: ZERO_USAGE }
	}
}

const workdirs: string[] = []
afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs.length = 0
})

/**
 * The loop, not the helper.
 *
 * `settleGraceMs` has its own tests above and every one of them passes with
 * the loop still calling a constant. Only a real run can say which number the
 * hold actually used.
 */
describe('the hold a run pays is the one its own budget allows', () => {
	async function runHoldingFor(timeoutMs: number): Promise<number> {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-grace-'))
		workdirs.push(workingDirectory)

		const inbox = new CompletionInbox()
		// `getTask` because the inbox asks the gateway about a task whose
		// completion may have been announced before the launch was recorded.
		// A double that omits a method the interface requires is not a smaller
		// gateway, it is a broken one.
		inbox.attach({ onTaskCompleted: () => () => {}, getTask: () => undefined } as never)
		// Outstanding and never settling: the worst case the bound exists for.
		// `expect` records the launch as well, so the inbox owns this task.
		inbox.expect('tsk_never' as TaskId)

		const startedAt = Date.now()
		await drainQuery({
			provider: new AnswersImmediately(),
			tools: new ToolRegistry(),
			completionInbox: inbox,
			agentId: 'agent_test',
			agentName: 'Test Agent',
			messages: [createUserMessage('go')],
			workingDirectory,
			runConfig: {
				model: 'mock-model',
				timeoutMs,
				tokenBudget: 100_000,
				maxIterations: 2,
				maxResponseTokens: 256,
			},
			sessionId: 'ses_grace' as SessionId,
			topicId: 'top_grace' as ThreadId,
			projectId: 'prj_grace' as ProjectId,
			tenantId: 'tnt_grace' as TenantId,
		} as never)
		return Date.now() - startedAt
	}

	it('a two-second run does not wait two minutes for a worker', async () => {
		const elapsed = await runHoldingFor(2_000)

		// Half of two seconds, plus whatever the turn itself costs. The number
		// this replaced would have parked here for 120 s regardless.
		expect(elapsed, 'the hold outlived the run budget that bounds it').toBeLessThan(5_000)
	}, 200_000)

	it('a run with no time left does not hold at all', async () => {
		// The guard stops this run at the top of its first iteration, so no
		// hold is even reached — which is the point: the last tenth of a run
		// already never holds, so no artificial minimum has to defend it.
		const elapsed = await runHoldingFor(1)

		expect(elapsed).toBeLessThan(2_000)
	}, 200_000)

	it('still delivers a completion that arrives inside the grace', async () => {
		// The bound must not become an excuse to drop what was nearly ready.
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-grace-hit-'))
		workdirs.push(workingDirectory)

		const inbox = new CompletionInbox()
		let announce: ((h: TaskHandle) => void) | undefined
		inbox.attach({
			onTaskCompleted: (cb: (h: TaskHandle) => void) => {
				announce = cb
				return () => {
					announce = undefined
				}
			},
			getTask: () => undefined,
		} as never)
		inbox.expect('tsk_soon' as TaskId)
		const timer = setTimeout(() => {
			announce?.({
				taskId: 'tsk_soon' as TaskId,
				agentId: 'reviewer',
				state: 'completed',
				createdAt: 0,
				completedAt: 1,
				result: { status: 'completed', result: 'ARRIVED INSIDE THE GRACE' },
			} as TaskHandle)
		}, 150)
		timer.unref?.()

		const run = await drainQuery({
			provider: new AnswersImmediately(),
			tools: new ToolRegistry(),
			completionInbox: inbox,
			agentId: 'agent_test',
			agentName: 'Test Agent',
			messages: [createUserMessage('go')],
			workingDirectory,
			runConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 3,
				maxResponseTokens: 256,
			},
			sessionId: 'ses_grace' as SessionId,
			topicId: 'top_grace' as ThreadId,
			projectId: 'prj_grace' as ProjectId,
			tenantId: 'tnt_grace' as TenantId,
		} as never)

		const userText = (run.messages as { role: string; content: unknown }[])
			.filter((m) => m.role === 'user')
			.map((m) => (typeof m.content === 'string' ? m.content : ''))

		expect(userText.some((m) => m.includes('ARRIVED INSIDE THE GRACE'))).toBe(true)
	}, 200_000)
})
