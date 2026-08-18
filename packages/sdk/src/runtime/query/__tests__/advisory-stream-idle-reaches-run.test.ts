import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import { RunCancelled } from '../../../types/run/cancel-cause.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

class AbortAwareAdvisorProvider implements LLMProvider {
	readonly id = 'stalled-advisor'
	readonly name = 'Stalled advisor'
	readonly transportSignals: AbortSignal[] = []
	readonly started: Promise<void>
	private markStarted!: () => void

	constructor() {
		this.started = new Promise((resolve) => {
			this.markStarted = resolve
		})
	}

	chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const signal = params.signal
		if (!signal) throw new Error('query did not give the advisor a transport signal')
		this.transportSignals.push(signal)
		const markStarted = this.markStarted

		return {
			[Symbol.asyncIterator]() {
				return {
					next: () =>
						new Promise<IteratorResult<StreamChunk>>((_resolve, reject) => {
							const onAbort = () => reject(signal.reason)
							if (signal.aborted) onAbort()
							else signal.addEventListener('abort', onAbort, { once: true })
							markStarted()
						}),
					return: async () => ({ done: true, value: undefined }),
				}
			},
		}
	}
}

function tools(): ToolRegistry {
	const registry = new ToolRegistry()
	registry.register({
		name: 'echo',
		description: 'Return the supplied text.',
		inputSchema: z.object({ text: z.string() }),
		execute: async ({ text }) => ({ success: true, output: text }),
	})
	return registry
}

function params(
	main: LLMProvider,
	advisor: LLMProvider,
	workingDirectory: string,
	caller: AbortController,
	idleTimeoutMs: number,
) {
	return {
		provider: main,
		tools: tools(),
		runConfig: {
			model: 'main-model',
			timeoutMs: 5_000,
			streamIdleTimeoutMs: idleTimeoutMs,
			tokenBudget: 100_000,
			maxIterations: 3,
			maxResponseTokens: 256,
		},
		advisory: {
			advisors: [
				{
					id: 'reviewer',
					name: 'Reviewer',
					provider: advisor,
					model: 'advisor-model',
				},
			],
			triggers: [
				{
					id: 'every-turn',
					condition: { type: 'on_iteration' as const, everyN: 1 },
					advisorId: 'reviewer',
				},
			],
		},
		agentId: 'agent_advisory_idle',
		agentName: 'Advisory Idle Agent',
		messages: [createUserMessage('Use echo, then answer.')],
		workingDirectory,
		sessionId: 'ses_advisory_idle' as SessionId,
		topicId: 'top_advisory_idle' as TopicId,
		projectId: 'prj_advisory_idle' as ProjectId,
		tenantId: 'tnt_advisory_idle' as TenantId,
		signal: caller.signal,
		retry: false as const,
	}
}

describe('query-owned advisors inherit the run stream boundary', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	async function workdir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-advisory-idle-'))
		workdirs.push(dir)
		return dir
	}

	it('aborts a stalled advisor privately, swallows that phase failure, and completes the run', async () => {
		const main = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ name: 'echo', args: { text: 'ready' } }] },
				{ text: 'main run completed' },
			],
		})
		const advisor = new AbortAwareAdvisorProvider()
		const caller = new AbortController()
		const events: RunEvent[] = []
		const safety = setTimeout(
			() => caller.abort(new Error('test safety bound: advisor watchdog did not settle')),
			1_000,
		)

		try {
			const run = await drainQuery(params(main, advisor, await workdir(), caller, 10), (event) => {
				events.push(event)
			})

			expect(run.status).toBe('completed')
			expect(run.stopReason).toBe('end_turn')
			expect(run.result).toBe('main run completed')
			expect(main.requests).toHaveLength(2)
			expect(advisor.transportSignals).toHaveLength(1)
			expect(advisor.transportSignals[0]?.aborted).toBe(true)
			expect(advisor.transportSignals[0]?.reason).toMatchObject({
				name: 'ProviderRequestError',
				kind: 'network',
				providerId: advisor.id,
			})
			expect(events.some((event) => event.type === 'run_failed')).toBe(false)
			expect([...events].reverse().find((event) => event.type === 'run_completed')).toMatchObject({
				type: 'run_completed',
				stopReason: 'end_turn',
			})
			expect(caller.signal.aborted).toBe(false)
		} finally {
			clearTimeout(safety)
			if (!caller.signal.aborted) caller.abort(new Error('test cleanup'))
		}
	})

	it('closes a pending advisor with the run cancellation cause', async () => {
		const main = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'echo', args: { text: 'ready' } }] }],
		})
		const advisor = new AbortAwareAdvisorProvider()
		const caller = new AbortController()
		const events: RunEvent[] = []
		const running = drainQuery(params(main, advisor, await workdir(), caller, 0), (event) => {
			events.push(event)
		})

		await Promise.race([
			advisor.started,
			new Promise<never>((_resolve, reject) =>
				setTimeout(() => reject(new Error('advisor request did not start')), 500),
			),
		])
		const stop = new Error('operator stopped the advisory run')
		caller.abort(stop)

		const run = await Promise.race([
			running,
			new Promise<never>((_resolve, reject) =>
				setTimeout(() => reject(new Error('advisor ignored run cancellation')), 200),
			),
		])

		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(advisor.transportSignals).toHaveLength(1)
		expect(advisor.transportSignals[0]?.aborted).toBe(true)
		expect(advisor.transportSignals[0]?.reason).toBe(stop)
		expect([...events].reverse().find((event) => event.type === 'run_completed')).toMatchObject({
			type: 'run_completed',
			stopReason: 'cancelled',
		})
	})

	it('starts no main or advisory model call when the caller already cancelled', async () => {
		const main = new MockLLMProvider({ turns: [{ text: 'must not run' }] })
		const advisor = new AbortAwareAdvisorProvider()
		const caller = new AbortController()
		const stop = new RunCancelled('user')
		caller.abort(stop)
		const events: RunEvent[] = []

		const run = await drainQuery(params(main, advisor, await workdir(), caller, 10), (event) => {
			events.push(event)
		})

		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(main.requests).toHaveLength(0)
		expect(advisor.transportSignals).toHaveLength(0)
		expect([...events].reverse().find((event) => event.type === 'run_completed')).toMatchObject({
			type: 'run_completed',
			stopReason: 'cancelled',
			cancelCause: 'user',
		})
	})
})
