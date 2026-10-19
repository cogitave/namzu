import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { ProviderRequestError } from '../../provider/errors.js'
import { InMemorySessionLog } from '../../store/session-log/index.js'
import { testToolset } from '../../test-support/toolset.js'
import type { SupervisorAgentConfig } from '../../types/agent/index.js'
import type { SessionId, TenantId, TurnId } from '../../types/ids/index.js'
import type { LLMProvider, StreamChunk } from '../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import type { SessionEvent } from '../../types/session/index.js'
import { SupervisorAgent } from '../SupervisorAgent.js'

/**
 * A turn that ended in `turn_paused` after a provider stream was cut could
 * only be continued below the supervisor, through `resumeSession`, which does
 * not know the supervisor's delegation, budget or scheduler wiring. The only
 * thing a supervisor host could do was run the turn again from iteration 0,
 * repeating tool calls that had already had their effect.
 */

const SESSION_ID = '8b71f555-ab2b-4a78-be42-3109378b5888' as SessionId
const USAGE = {
	promptTokens: 1,
	completionTokens: 1,
	totalTokens: 2,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

/** Iteration 1 calls `echo`; iteration 2 is cut mid-stream; the next one answers. */
class CutStreamProvider implements LLMProvider {
	readonly id = 'cut-stream'
	readonly name = 'Cut Stream Provider'
	calls = 0
	/** How many times the cut repeats before the stream is allowed to finish. */
	constructor(
		private readonly cuts = 1,
		private readonly reportUsage = false,
	) {}

	async *chatStream(): AsyncIterable<StreamChunk> {
		this.calls += 1
		if (this.calls === 1) {
			yield {
				id: 'c1',
				delta: {
					toolCalls: [
						{
							index: 0,
							id: 'call_echo',
							type: 'function',
							function: { name: 'echo', arguments: '{"text":"hi"}' },
						},
					],
				},
			}
			yield { id: 'c1', delta: {}, finishReason: 'tool_calls', usage: USAGE }
			return
		}
		if (this.calls <= 1 + this.cuts) {
			yield {
				id: 'c2',
				delta: { content: 'part of an ans' },
				...(this.reportUsage ? { usage: USAGE } : {}),
			}
			// What a driver raises for a cut connection (`TypeError: terminated`
			// from fetch, classified): retryable, with no retry left to spend.
			throw new ProviderRequestError({
				kind: 'network',
				providerId: 'cut-stream',
				detail: 'terminated',
			})
		}
		yield { id: 'c3', delta: { content: 'the answer' } }
		yield { id: 'c3', delta: {}, finishReason: 'stop', usage: USAGE }
	}
}

function harness(provider: LLMProvider, tokenBudget = 0) {
	const echo = vi.fn(async () => ({ success: true, output: 'hi' }))
	const sessionLog = new InMemorySessionLog({ sessionId: SESSION_ID })
	const events: SessionEvent[] = []
	const agent = new SupervisorAgent({
		id: 'supervisor',
		name: 'Supervisor',
		version: '1',
		category: 'test',
		description: 'coordinates workers',
	})
	const manager = {
		sendMessage: vi.fn(),
		await: vi.fn(async () => undefined),
		cancel: vi.fn(),
		cancelAll: vi.fn(),
		dispose: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
	}
	const config = {
		provider,
		agentIds: ['worker'],
		agentManager: manager,
		toolsets: [
			testToolset({
				name: 'echo',
				description: 'echo the text back',
				inputSchema: z.object({ text: z.string() }),
				execute: echo,
			}),
		],
		systemPrompt: 'You coordinate.',
		model: 'mock-model',
		tokenBudget,
		timeoutMs: 30_000,
		maxIterations: 6,
		sessionId: SESSION_ID,
		topicId: '18fd1af5-acfa-402d-b733-693691c1820e' as TopicId,
		projectId: 'f00d2464-af09-4609-99e5-79def1ea043d' as ProjectId,
		tenantId: '17621f97-7a3a-4a70-b704-29f1441d224b' as TenantId,
		sessionLog,
	} as unknown as SupervisorAgentConfig
	const listener = (event: SessionEvent) => {
		events.push(event)
	}
	const input = async () => ({
		messages: [{ role: 'user' as const, content: 'go', timestamp: 1 }],
		workingDirectory: await mkdtemp(join(tmpdir(), 'namzu-sup-resume-')),
	})
	return { agent, config, listener, events, echo, input }
}

function paused(events: readonly SessionEvent[]) {
	return events.filter((e) => e.type === 'turn_paused')
}

describe('SupervisorAgent.resume', () => {
	it('continues the paused turn id from its checkpoint without repeating tool calls', async () => {
		const provider = new CutStreamProvider()
		const { agent, config, listener, events, echo, input } = harness(provider)
		const workspace = await input()

		const first = await agent.run(workspace, config, listener)

		expect(first.status).toBe('failed')
		const pauses = paused(events)
		expect(pauses).toHaveLength(1)
		const pause = pauses[0]
		if (pause?.type !== 'turn_paused') throw new Error('expected turn_paused')
		expect(pause.turnId).toBe(first.turnId)
		expect(echo).toHaveBeenCalledTimes(1)

		const second = await agent.resume(
			workspace,
			config,
			{ turnId: first.turnId, checkpointId: pause.checkpointId },
			listener,
		)

		expect(second.turnId).toBe(first.turnId)
		expect(second.status).toBe('completed')
		expect(second.result).toBe('the answer')
		// The tool iteration is in the folded context, not run again.
		expect(echo).toHaveBeenCalledTimes(1)
		expect(provider.calls).toBe(3)
		expect(events.filter((e) => e.type === 'turn_completed')).toHaveLength(1)
	})

	it('defaults to the newest checkpoint and pauses again if the stream is cut again', async () => {
		const provider = new CutStreamProvider(2)
		const { agent, config, listener, events, echo, input } = harness(provider)
		const workspace = await input()

		const first = await agent.run(workspace, config, listener)
		const second = await agent.resume(workspace, config, { turnId: first.turnId }, listener)

		// A host bounds its resumes by counting `turn_paused`.
		expect(second.turnId).toBe(first.turnId)
		expect(second.status).toBe('failed')
		expect(paused(events)).toHaveLength(2)

		const third = await agent.resume(workspace, config, { turnId: first.turnId }, listener)
		expect(third.status).toBe('completed')
		expect(echo).toHaveBeenCalledTimes(1)
	})

	it('resumes under a finite token budget when the cut stream reported its usage', async () => {
		const { agent, config, listener, events, echo, input } = harness(
			new CutStreamProvider(1, true),
			100_000,
		)
		const workspace = await input()

		const first = await agent.run(workspace, config, listener)
		expect(paused(events)).toHaveLength(1)
		const second = await agent.resume(workspace, config, { turnId: first.turnId }, listener)

		expect(second.turnId).toBe(first.turnId)
		expect(second.status).toBe('completed')
		expect(echo).toHaveBeenCalledTimes(1)
	})

	it('refuses a turn that already ended', async () => {
		const { agent, config, listener, events, input } = harness(new CutStreamProvider(0))
		const workspace = await input()

		const done = await agent.run(workspace, config, listener)
		expect(done.status).toBe('completed')
		expect(paused(events)).toHaveLength(0)

		await expect(agent.resume(workspace, config, { turnId: done.turnId })).rejects.toMatchObject({
			code: 'invalid_config',
		})
	})

	it('refuses a turn and a checkpoint it does not know', async () => {
		const { agent, config, listener, input } = harness(new CutStreamProvider())
		const workspace = await input()
		const first = await agent.run(workspace, config, listener)

		await expect(
			agent.resume(workspace, config, {
				turnId: '9dbf5ebc-ce42-425d-aeee-c60e281113c2' as TurnId,
			}),
		).rejects.toMatchObject({ code: 'invalid_config' })
		await expect(
			agent.resume(workspace, config, {
				turnId: first.turnId,
				checkpointId: '198e213b-0e39-40d2-8484-2d6e8cc9d83f' as never,
			}),
		).rejects.toMatchObject({ code: 'invalid_config' })
	})

	it('needs the session log the turn was written to', async () => {
		const { agent, config, input } = harness(new CutStreamProvider())
		const { sessionLog: _log, ...withoutLog } = config as SupervisorAgentConfig & {
			sessionLog?: unknown
		}

		await expect(
			agent.resume(await input(), withoutLog as SupervisorAgentConfig, {
				turnId: '9dbf5ebc-ce42-425d-aeee-c60e281113c2' as TurnId,
			}),
		).rejects.toMatchObject({ code: 'invalid_config' })
	})
})
