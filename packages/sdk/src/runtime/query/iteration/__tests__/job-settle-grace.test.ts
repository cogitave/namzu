import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../../../provider/mock.js'
import { ToolRegistry } from '../../../../registry/tool/execute.js'
import { WaitForJobTool } from '../../../../tools/builtins/wait-for-job.js'
import { DELEGATION_TIMEOUT_MS } from '../../../../tools/coordinator/index.js'
import { defineTool } from '../../../../tools/defineTool.js'
import type { MockTurn } from '../../../../types/provider/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../../utils/id.js'
import { BackgroundJobRegistry } from '../../../jobs/registry.js'
import { drainQuery } from '../../index.js'
import { awaitedJobGraceMs, settleGraceMs } from '../index.js'

/**
 * The job half of `settle-grace.test.ts`.
 *
 * That file pins what a finishing run pays for a delegated worker; this one
 * pins the same three properties for a background job the model said it was
 * waiting on — it is bounded by the run's own budget, it is never paid for a
 * job nobody awaited, and what it gives up on is named rather than hidden.
 *
 * Every case drives a real `BackgroundJobRegistry`, because the question is
 * what the LOOP does. `AwaitedJobs` has arithmetic of its own and passes its
 * own tests whether or not `holdForOutstandingWork` ever races it.
 */

/** Starts a job the way `bash run_in_background` does, without the shell surface. */
const StartTool = defineTool({
	name: 'start',
	description: 'starts a background job',
	inputSchema: z.object({ command: z.string() }),
	category: 'shell',
	permissions: [],
	readOnly: false,
	destructive: false,
	concurrencySafe: true,
	execute: async ({ command }, context) => {
		const job = context.backgroundJobs?.start({
			command,
			workingDirectory: context.workingDirectory,
		})
		return { success: true, output: `started ${job?.id ?? 'nothing'}` }
	},
})

function tools(): ToolRegistry {
	const registry = new ToolRegistry()
	registry.register(StartTool)
	registry.register(WaitForJobTool)
	return registry
}

afterEach(() => {
	vi.unstubAllEnvs()
})

/** A fresh registry always hands out `job_1` first, so the script can name it. */
const START_LONG = {
	toolCalls: [{ id: 'c1', name: 'start', args: { command: 'sleep 30' } }],
} satisfies MockTurn
/** Gives up long before the job does, which is the case the hold backs up. */
const WAIT_BRIEFLY = {
	toolCalls: [{ id: 'c2', name: 'wait_for_job', args: { id: 'job_1', timeout_ms: 50 } }],
} satisfies MockTurn

async function run(options: {
	turns: MockTurn[]
	timeoutMs: number
	maxIterations: number
}) {
	const provider = new MockLLMProvider({ turns: options.turns })
	const backgroundJobs = new BackgroundJobRegistry()
	const startedAt = Date.now()
	const result = await drainQuery({
		provider,
		tools: tools(),
		agentId: 'job-hold-fixture',
		agentName: 'Job hold fixture',
		messages: [{ role: 'user', content: 'start the job' }],
		workingDirectory: process.cwd(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		tenantId: generateTenantId(),
		topicId: generateTopicId(),
		runConfig: {
			model: 'mock',
			maxIterations: options.maxIterations,
			tokenBudget: 200_000,
			timeoutMs: options.timeoutMs,
		},
		backgroundJobs,
	})
	// The run owns these jobs, so `drainQuery` has already stopped them; the
	// elapsed time is measured over that too, which is the honest number.
	return { result, provider, elapsedMs: Date.now() - startedAt }
}

describe('a run holds itself open only for a job the model awaited', () => {
	it('does not wait thirty seconds for it inside a two-second run', async () => {
		// The property `settleGraceMs` exists for, on the job side: the wait is
		// a share of what this run has left, not a share of how long the job
		// might take. `sleep 30` outlives the run's whole budget fifteen times
		// over, and the hold must not follow it there.
		const { result, elapsedMs } = await run({
			turns: [START_LONG, WAIT_BRIEFLY, { text: 'it is still going' }],
			timeoutMs: 2_000,
			maxIterations: 3,
		})

		expect(result.status).toBe('completed')
		expect(elapsedMs, 'the hold outlived the run budget that bounds it').toBeLessThan(5_000)
	}, 60_000)

	it('does not hold at all for a job nobody awaited', async () => {
		// The dev-server case, and the reason wait-intent is explicit. This run
		// has twenty seconds left, so a hold that triggered on job EXISTENCE
		// would park here for about nine of them — at the end of every turn,
		// for a process that is doing exactly what it was started to do.
		const { result, provider, elapsedMs } = await run({
			turns: [START_LONG, { text: 'the server is up' }],
			timeoutMs: 20_000,
			maxIterations: 3,
		})

		expect(result.status).toBe('completed')
		expect(elapsedMs, 'a job nobody waited for held the run open').toBeLessThan(3_000)
		// And it cost no extra turn either: two scripted turns, two requests.
		expect(provider.requests.length).toBe(2)
	}, 60_000)

	it('names the awaited job it walked away from', async () => {
		// The same statement `abandonedTaskIds` makes about a delegated worker.
		// A run that gave up waiting must not leave the impression the job
		// reported back — and must not pretend it stopped it either.
		const { result } = await run({
			turns: [START_LONG, WAIT_BRIEFLY, { text: 'giving up on it' }],
			timeoutMs: 2_000,
			maxIterations: 3,
		})

		expect(result.abandonedJobIds).toEqual(['job_1'])
		expect(result.abandonedTaskIds, 'a job is not a delegated task').toBeUndefined()
	}, 60_000)

	it('says nothing about a job that was never awaited', async () => {
		const { result } = await run({
			turns: [START_LONG, { text: 'the server is up' }],
			timeoutMs: 2_000,
			maxIterations: 3,
		})

		expect(result.abandonedJobIds).toBeUndefined()
	}, 60_000)

	it('does not park an unlimited run for the delegation hour', async () => {
		// The configuration the CLI actually ships: `timeoutMs: 0`, no run
		// deadline, so there is no remainder for the grace to take a share of
		// and `settleGraceMs` returns its ceiling flat. For a delegated task
		// that hour is the longest the task itself may live; a `sleep 30` —
		// or a watcher, or `tail -f` — has no such bound, and a run that spent
		// the ceiling on one would hold the session silent for an hour.
		vi.stubEnv('NAMZU_JOB_HOLD_MAX_MS', '400')
		const { result, elapsedMs } = await run({
			turns: [START_LONG, WAIT_BRIEFLY, { text: 'it is still going' }],
			timeoutMs: 0,
			maxIterations: 3,
		})

		expect(result.status).toBe('completed')
		expect(elapsedMs, 'an unlimited run held itself open past the job ceiling').toBeLessThan(5_000)
		// And it is the same statement a bounded run makes when it gives up.
		expect(result.abandonedJobIds).toEqual(['job_1'])
	}, 60_000)
})

describe('the job half of the grace has a ceiling of its own', () => {
	it('is the share of the run, wherever that is the smaller number', () => {
		expect(awaitedJobGraceMs(60_000)).toBe(settleGraceMs(60_000))
		expect(awaitedJobGraceMs(0)).toBe(0)
	})

	it('stops well short of the hour a delegated worker may wait', () => {
		// The case that matters, because it is the CLI's default: with no
		// deadline the task ceiling binds flat, and the job ceiling is what
		// keeps a timed-out `wait_for_job` from being followed by an hour of
		// silence.
		expect(settleGraceMs(Number.POSITIVE_INFINITY)).toBe(DELEGATION_TIMEOUT_MS)
		expect(awaitedJobGraceMs(Number.POSITIVE_INFINITY)).toBe(2 * 60 * 1000)
	})

	it('never waits longer than the run would have for a task', () => {
		for (const remaining of [1, 250, 30_000, 600_000, 3_600_000, Number.POSITIVE_INFINITY]) {
			expect(awaitedJobGraceMs(remaining)).toBeLessThanOrEqual(settleGraceMs(remaining))
		}
	})

	it('takes the host’s ceiling when there is one', () => {
		vi.stubEnv('NAMZU_JOB_HOLD_MAX_MS', '5000')
		expect(awaitedJobGraceMs(Number.POSITIVE_INFINITY)).toBe(5_000)

		// A value that is not a positive whole number of milliseconds is not a
		// ceiling; the default stands rather than a run holding for NaN.
		vi.stubEnv('NAMZU_JOB_HOLD_MAX_MS', 'soon')
		expect(awaitedJobGraceMs(Number.POSITIVE_INFINITY)).toBe(2 * 60 * 1000)
	})
})
