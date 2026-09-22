import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { WaitForJobTool } from '../../../tools/builtins/wait-for-job.js'
import { defineTool } from '../../../tools/defineTool.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { BackgroundJobRegistry } from '../../jobs/registry.js'
import { drainQuery } from '../index.js'

/**
 * What a turn does when the model stops calling tools while a job it said it
 * was waiting on is still running.
 *
 * Before this, nothing: the turn settled, and the exit notice — which needs a
 * tool result to ride on — had none left to ride. The recorded run that
 * motivated `wait_for_job` shows what the model does instead, and it is not
 * nothing: six `job read` polls, three `job list` polls and an improvised
 * `sleep 30`, each a full context resend
 * (research/resident/results/2026-09-14-exploration-policy-terra-tui.json).
 *
 * `provider.requests` is the unit that incident was measured in — one entry
 * per model turn — so it is the unit these assertions use. A hold that cost a
 * single provider request during the wait would be the same defect in kernel
 * clothing.
 */

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

const ids = () => ({
	projectId: generateProjectId(),
	sessionId: generateSessionId(),
	tenantId: generateTenantId(),
	topicId: generateTopicId(),
})

/** Waits far less than the job needs, so the turn ends with it still running. */
const WAIT_BRIEFLY = {
	toolCalls: [{ id: 'c2', name: 'wait_for_job', args: { id: 'job_1', timeout_ms: 50 } }],
} satisfies MockTurn

const leftRunning: { registry: BackgroundJobRegistry; owner: string }[] = []
afterEach(async () => {
	vi.unstubAllEnvs()
	for (const { registry, owner } of leftRunning.splice(0)) {
		await registry.killOwner(owner).catch(() => {})
	}
})

describe('a turn suspends for a job the model awaited, and pays no tokens for it', () => {
	it('waits without a provider request, then gives the model one turn with the exit', async () => {
		const backgroundJobs = new BackgroundJobRegistry()
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'start', args: { command: 'sleep 1.5' } }] },
				WAIT_BRIEFLY,
				{ text: 'still waiting on it' },
				{ text: 'the job finished' },
			],
		})
		// Sampled at the moment the job stops, which is the far end of the
		// hold: whatever the model had cost by then is what the wait cost. The
		// job outlasts the three scripted turns by a wide margin, so the
		// sample is taken inside the hold rather than beside it.
		let requestsWhenJobExited = -1
		backgroundJobs.onExit(() => {
			requestsWhenJobExited = provider.requests.length
		})

		const run = await drainQuery({
			provider,
			tools: tools(),
			agentId: 'job-hold-fixture',
			agentName: 'Job hold fixture',
			messages: [createUserMessage('start the job and tell me when it ends')],
			workingDirectory: process.cwd(),
			...ids(),
			turnConfig: {
				model: 'mock',
				maxIterations: 6,
				tokenBudget: 200_000,
				timeoutMs: 30_000,
			},
			backgroundJobs,
		})

		expect(run.status).toBe('completed')
		// Three turns had been asked for when the job ended: start, wait,
		// "still waiting". The hold spent real time and no tokens.
		expect(requestsWhenJobExited, 'the hold asked the model something while it waited').toBe(3)
		// And exactly one turn after it — the turn the wait was for. A loop
		// would show more; an ending turn would show three.
		expect(provider.requests.length).toBe(4)

		// The model learns of the exit on the channel a job exit already uses,
		// delivered once. Twice would be the duplicate that got the previous
		// version of this delivery removed on the task side.
		const lastRequest = provider.requests[3]
		const notices = (lastRequest?.messages ?? []).filter(
			(message) =>
				typeof message.content === 'string' && message.content.includes('[Background job update]'),
		)
		expect(notices.length).toBe(1)
		expect(notices[0]?.content).toContain('job_1')
	}, 60_000)

	it('goes on waiting for a second job after the first one’s exit was read', async () => {
		// An exit reaches the model on the next tool result whenever there is
		// one, which is most of the time — and what the hold must not do is
		// treat the record of that delivery as news. It did: with `job_1`’s
		// exit already read and `job_2` still running, the wait returned
		// before it began, the drain found no notice to deliver, and the turn
		// settled over a job it was supposed to be waiting for. The same
		// instant return ends the delegated-task leg of this race, which is
		// why it is a regression in the older half of the hold too.
		const backgroundJobs = new BackgroundJobRegistry()
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'start', args: { command: 'sleep 0.5' } }] },
				{ toolCalls: [{ id: 'c2', name: 'start', args: { command: 'sleep 3' } }] },
				// Long enough that `job_1` exits inside the call: its notice is
				// then queued while a tool result is still being assembled, so
				// it rides out on THIS batch and is read.
				{
					toolCalls: [{ id: 'c3', name: 'wait_for_job', args: { id: 'job_1', timeout_ms: 5_000 } }],
				},
				{ toolCalls: [{ id: 'c4', name: 'wait_for_job', args: { id: 'job_2', timeout_ms: 50 } }] },
				{ text: 'job_2 is still going' },
				{ text: 'job_2 finished too' },
			],
		})

		const run = await drainQuery({
			provider,
			tools: tools(),
			agentId: 'job-hold-fixture',
			agentName: 'Job hold fixture',
			messages: [createUserMessage('start both and tell me when the second ends')],
			workingDirectory: process.cwd(),
			...ids(),
			turnConfig: {
				model: 'mock',
				maxIterations: 8,
				tokenBudget: 200_000,
				timeoutMs: 30_000,
			},
			backgroundJobs,
		})

		expect(run.status).toBe('completed')
		// Six scripted turns, the last of them the one the hold bought. Five
		// would mean the turn settled at the text turn instead of waiting.
		expect(provider.requests.length).toBe(6)
		expect(
			run.abandonedJobIds,
			'the turn walked away from the job it was waiting on',
		).toBeUndefined()

		const lastRequest = provider.requests[5]
		const notices = (lastRequest?.messages ?? [])
			.map((message) => (typeof message.content === 'string' ? message.content : ''))
			.filter((content) => content.includes('[Background job update]'))
		// One per job, each on its own channel: `job_1` on the tool result it
		// exited during, `job_2` on the message the hold delivered.
		expect(notices.filter((content) => content.includes('job_1')).length).toBe(1)
		expect(notices.filter((content) => content.includes('job_2')).length).toBe(1)
	}, 60_000)

	it('delivers an exit that lands in the moment the turn is settling', async () => {
		// The grace boundary. The hold asks for an exit, the job has not ended
		// yet, and the wait is over; the job then ends a tick later, which
		// takes it off the outstanding list on its way past. So the turn had
		// not delivered it — the hold had already looked — and could not
		// honestly name it on `abandonedJobIds` either, because it did not
		// walk away from a job that finished. The session's own announcer is
		// no help: it speaks only for an exit that lands with no turn in
		// flight, and this one is still in flight. The exit belonged to
		// nobody.
		//
		// A tick is not something a timer can be aimed at, so this sits in it
		// instead: `drainQuery` awaits its listener between yields, which
		// parks the turn on the last event the loop emits before it settles.
		vi.stubEnv('NAMZU_JOB_HOLD_MAX_MS', '50')
		const backgroundJobs = new BackgroundJobRegistry()
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'start', args: { command: 'sleep 30' } }] },
				WAIT_BRIEFLY,
				{ text: 'it is still going' },
			],
		})

		let ended = false
		const run = await drainQuery(
			{
				provider,
				tools: tools(),
				agentId: 'job-hold-fixture',
				agentName: 'Job hold fixture',
				messages: [createUserMessage('start the job and tell me when it ends')],
				workingDirectory: process.cwd(),
				...ids(),
				turnConfig: {
					model: 'mock',
					maxIterations: 6,
					tokenBudget: 200_000,
					// No deadline, so the job ceiling stubbed above is what ends
					// the hold — the CLI's configuration, and the one where the
					// boundary is reached rather than the turn's own clock.
					timeoutMs: 0,
				},
				backgroundJobs,
			},
			async (event) => {
				// The turn that called no tools is the one the hold ran on, and
				// this event is emitted after it gave up and before the turn
				// settles.
				if (ended || event.type !== 'iteration_completed' || event.hasToolCalls) return
				ended = true
				await backgroundJobs.kill('job_1')
			},
		)

		expect(ended, 'the turn never reached the turn the hold gives up on').toBe(true)
		expect(run.status).toBe('completed')
		// Nobody was waiting on it by then, so this bought no turn: three
		// scripted turns, three requests.
		expect(provider.requests.length).toBe(3)
		// Named as abandoned would be a false claim — it ended.
		expect(run.abandonedJobIds).toBeUndefined()
		// And the exit is in the transcript the host reads, not lost between
		// the two layers that each thought the other had it.
		const notices = (run.messages as { content: unknown }[])
			.map((message) => (typeof message.content === 'string' ? message.content : ''))
			.filter((content) => content.includes('[Background job update]'))
		expect(notices.length).toBe(1)
		expect(notices[0]).toContain('job_1')
		// Appended after the final assistant turn, so the turn's own answer has
		// to have been fixed before it went on.
		expect(run.result).toContain('it is still going')
	}, 60_000)

	it('leaves a job nobody awaited to run, and ends the turn at once', async () => {
		// The dev-server case. `sleep 30` outlives this turn's twenty-second
		// budget, and a turn that held for it would sit here for about nine
		// seconds before answering.
		const backgroundJobs = new BackgroundJobRegistry()
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'start', args: { command: 'sleep 30' } }] },
				{ text: 'the server is running in the background' },
			],
		})

		const startedAt = Date.now()
		const run = await drainQuery({
			provider,
			tools: tools(),
			agentId: 'job-hold-fixture',
			agentName: 'Job hold fixture',
			messages: [createUserMessage('start the dev server')],
			workingDirectory: process.cwd(),
			...ids(),
			turnConfig: {
				model: 'mock',
				maxIterations: 6,
				tokenBudget: 200_000,
				timeoutMs: 20_000,
			},
			backgroundJobs,
		})

		expect(run.status).toBe('completed')
		expect(Date.now() - startedAt, 'the turn held open for a job nobody awaited').toBeLessThan(
			3_000,
		)
		expect(provider.requests.length).toBe(2)
	}, 60_000)

	it('lets an operator message through the hold without touching the job', async () => {
		// The existing `ctx.waitForInbound` leg, which the CLI supplies. An
		// operator who types while the kernel is waiting must not have to wait
		// out the grace — and the release is a statement about the WAIT, never
		// about the work: the job is still running afterwards.
		const backgroundJobs = new BackgroundJobRegistry()
		const owner = 'ws6-operator-session'
		leftRunning.push({ registry: backgroundJobs, owner })
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'start', args: { command: 'sleep 30' } }] },
				WAIT_BRIEFLY,
				{ text: 'waiting' },
				{ text: 'reading your message' },
			],
		})

		// An operator who keeps typing: every hold is released by a message
		// rather than by its deadline, which is what makes the elapsed time
		// below a statement about the leg and not about the timer.
		let typed = 0
		const queued: ReturnType<typeof createUserMessage>[] = []
		const waitForInbound = (signal: AbortSignal) =>
			new Promise<void>((resolve) => {
				if (queued.length > 0) {
					resolve()
					return
				}
				const timer = setTimeout(() => {
					typed += 1
					queued.push(createUserMessage(`operator note ${typed}`))
					resolve()
				}, 80)
				timer.unref?.()
				signal.addEventListener('abort', () => {
					clearTimeout(timer)
					resolve()
				})
			})

		const startedAt = Date.now()
		const run = await drainQuery({
			provider,
			tools: tools(),
			agentId: 'job-hold-fixture',
			agentName: 'Job hold fixture',
			messages: [createUserMessage('start the job')],
			workingDirectory: process.cwd(),
			...ids(),
			turnConfig: {
				model: 'mock',
				maxIterations: 4,
				tokenBudget: 200_000,
				// A minute of budget, so the grace the hold would otherwise pay
				// is roughly twenty-seven seconds. The assertion below is far
				// under it.
				timeoutMs: 60_000,
			},
			backgroundJobs,
			backgroundJobOwner: owner,
			inboundMessages: () => queued.splice(0),
			waitForInbound,
		})

		expect(run.status).toBe('completed')
		expect(typed, 'the hold never reached the operator leg').toBeGreaterThan(0)
		expect(Date.now() - startedAt, 'the operator message did not release the hold').toBeLessThan(
			5_000,
		)
		// Untouched: released the waiter, not the work.
		expect(backgroundJobs.get('job_1').status).toBe('running')
		const delivered = (run.messages as { role: string; content: unknown }[]).filter(
			(message) => message.role === 'user' && String(message.content).startsWith('operator note'),
		)
		expect(delivered.length).toBeGreaterThan(0)
	}, 60_000)
})
