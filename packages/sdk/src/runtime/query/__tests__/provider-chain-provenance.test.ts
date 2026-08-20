/**
 * The run RECORD names the member that served.
 *
 * The wire and the metering already followed the chain when this file was
 * written; the durable record did not. It named the head — which is worse than
 * naming nothing, because a missing field reads as unknown and a wrong one
 * reads as a fact. Six months later a reader would conclude the primary served
 * a turn it never saw.
 *
 * Every case here reads the property off `run` — the object a host persists —
 * and not off the event stream. The events were already right
 * (`provider-chain-failover.test.ts` pins them), so an assertion on them would
 * pass with this whole change deleted:
 * `docs/conventions/sound-about-the-wrong-thing.md`.
 *
 * Every scripted turn that must appear in the ledger calls a tool, and that is
 * load-bearing rather than decorative. The loop records a step only on the
 * tool-calling path: `if (forceFinalize || !hasToolCalls)` breaks out before
 * `recordStep`, so the turn that produces the ANSWER is not in `steps` at all.
 * A first draft of this file scripted text-only turns and asserted against an
 * empty ledger. That gap is older than this change and is not fixed here — it
 * is why `metadata.servingProvider` matters, since the commonest failover of
 * all is a fallback that answers on its first turn and leaves no step behind.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { failingStream } from '../../../__fixtures__/failing-stream.js'
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
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/** A provider that always fails the way `status` says, before any chunk. */
function failing(id: string, status: number): LLMProvider {
	return {
		id,
		name: id,
		chatStream: (_params: ChatCompletionParams): AsyncIterable<StreamChunk> =>
			failingStream(Object.assign(new Error(`HTTP ${status}`), { status })),
	} as unknown as LLMProvider
}

/**
 * A provider that serves `okTurns` turns and then fails every later one.
 *
 * The point of the shape is the step AFTER the swap: a chain that falls over on
 * turn 2 emits its notice during turn 2 and nothing at all on turn 3, so a
 * record built from the in-band chunk alone gets turn 3 wrong.
 */
function healthyThenFailing(id: string, okTurns: number, status: number): LLMProvider {
	const inner = new MockLLMProvider({
		nextTurn: (_params, index) =>
			index < okTurns
				? { toolCalls: [{ id: `c${index}`, name: 'echo', rawArguments: '{}' }] }
				: { error: { message: `HTTP ${status}`, status } },
	})
	return {
		id,
		name: id,
		chatStream: (params: ChatCompletionParams) => inner.chatStream(params),
	} as unknown as LLMProvider
}

function registerEcho(tools: ToolRegistry): void {
	tools.register({
		name: 'echo',
		description: 'Echo the text back.',
		inputSchema: z.object({ text: z.string().optional() }),
		execute: async () => ({ success: true, output: 'ok' }),
	})
}

function baseParams(
	provider: LLMProvider,
	tools: ToolRegistry,
	workingDirectory: string,
	maxIterations = 1,
) {
	return {
		provider,
		tools,
		runConfig: {
			model: 'primary-model',
			timeoutMs: 5_000,
			tokenBudget: 100_000,
			maxIterations,
			maxResponseTokens: 256,
		},
		agentId: 'agent_test',
		agentName: 'Test Agent',
		workingDirectory,
		sessionId: 'ses_prov' as SessionId,
		topicId: 'top_prov' as TopicId,
		projectId: 'prj_prov' as ProjectId,
		tenantId: 'tnt_prov' as TenantId,
		// Every failure below is on a code the retry decorator declines, so this
		// only guards against an accidental retryable status parking the suite.
		retry: false as const,
	}
}

describe('the run record names the member that served', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	async function mkWorkdir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-prov-'))
		workdirs.push(dir)
		return dir
	}

	it('attributes the step to the member that answered, not to the declared head', async () => {
		const primary = failing('primary', 401)
		const fallback = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'f1', name: 'echo', rawArguments: '{}' }] },
				{ text: 'answered' },
			],
		})
		const tools = new ToolRegistry()
		registerEcho(tools)

		const run = await drainQuery({
			...baseParams(primary, tools, await mkWorkdir(), 2),
			fallbackProviders: [{ provider: fallback, model: 'fallback-model' }],
			messages: [createUserMessage('hello')],
		})

		expect(run.status).toBe('completed')
		expect(run.steps?.[0]?.servedBy).toEqual({
			providerId: fallback.id,
			model: 'fallback-model',
			chainIndex: 1,
		})
	})

	it('stamps native replay state with the exact fallback route that produced it', async () => {
		const replayState = {
			kind: 'fixture-native-state',
			version: 1,
			reasoning: 'fallback thought',
		}
		const received: ChatCompletionParams[] = []
		const fallback: LLMProvider = {
			id: 'fallback-native',
			name: 'fallback native',
			async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
				received.push(params)
				yield {
					id: 'native-1',
					delta: { reasoning: { index: 0, type: 'thinking', text: 'fallback thought' } },
				}
				yield { id: 'native-1', delta: { content: 'answered' } }
				yield {
					id: 'native-1',
					delta: {},
					finishReason: 'stop',
					replayState,
					usage: {
						promptTokens: 2,
						completionTokens: 3,
						totalTokens: 5,
						cachedTokens: 0,
						cacheWriteTokens: 0,
					},
				}
			},
		}

		const run = await drainQuery({
			...baseParams(failing('primary', 401), new ToolRegistry(), await mkWorkdir()),
			fallbackProviders: [{ provider: fallback, model: 'fallback-model' }],
			messages: [createUserMessage('hello')],
		})

		expect(received).toHaveLength(1)
		expect(received[0]?.providerRoute).toEqual({
			providerId: 'fallback-native',
			model: 'fallback-model',
			chainIndex: 1,
		})
		const assistant = run.messages.find((message) => message.role === 'assistant')
		expect(assistant).toMatchObject({
			role: 'assistant',
			content: 'answered',
			reasoning: [{ type: 'thinking', text: 'fallback thought' }],
			source: {
				type: 'model',
				providerId: 'fallback-native',
				model: 'fallback-model',
				chainIndex: 1,
				replayState,
			},
		})
	})

	it('keeps the fallback route on the separate forced-final response and its cost', async () => {
		const finalReplayState = { kind: 'fixture-final-state', version: 1, signature: 'final' }
		const routes: ChatCompletionParams['providerRoute'][] = []
		let call = 0
		const usage = {
			promptTokens: 1_000_000,
			completionTokens: 1_000_000,
			totalTokens: 2_000_000,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		}
		const fallback: LLMProvider = {
			id: 'anthropic',
			name: 'fallback anthropic',
			async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
				routes.push(params.providerRoute)
				call += 1
				if (call === 1) {
					yield {
						id: 'tool-turn',
						delta: {
							toolCalls: [
								{
									index: 0,
									id: 'echo-1',
									type: 'function',
									function: { name: 'echo', arguments: '{"text":"hi"}' },
								},
							],
						},
					}
					yield { id: 'tool-turn', delta: {}, finishReason: 'tool_calls', usage }
					return
				}
				yield {
					id: 'final-turn',
					delta: {
						reasoning: {
							index: 0,
							type: 'thinking',
							text: 'final thought',
							signature: 'final-sig',
						},
					},
				}
				yield { id: 'final-turn', delta: { content: 'final answer' } }
				yield {
					id: 'final-turn',
					delta: {},
					finishReason: 'stop',
					usage,
					replayState: finalReplayState,
				}
			},
		}
		const tools = new ToolRegistry()
		registerEcho(tools)
		const base = baseParams(failing('anthropic', 401), tools, await mkWorkdir(), 10)
		const run = await drainQuery({
			...base,
			runConfig: {
				...base.runConfig,
				model: 'claude-opus-5',
				tokenBudget: 1,
			},
			fallbackProviders: [{ provider: fallback, model: 'claude-haiku-4-5' }],
			messages: [createUserMessage('hello')],
		})

		expect(routes).toEqual([
			{ providerId: 'anthropic', model: 'claude-haiku-4-5', chainIndex: 1 },
			{ providerId: 'anthropic', model: 'claude-haiku-4-5', chainIndex: 1 },
		])
		expect(run.stopReason).toBe('token_budget')
		expect(run.costInfo.totalCost).toBeCloseTo(12, 6)
		expect(run.messages.at(-1)).toMatchObject({
			role: 'assistant',
			content: 'final answer',
			reasoning: [{ type: 'thinking', text: 'final thought', signature: 'final-sig' }],
			source: {
				type: 'model',
				providerId: 'anthropic',
				model: 'claude-haiku-4-5',
				chainIndex: 1,
				replayState: finalReplayState,
			},
		})
	})

	it('keeps the declared head on `metadata.provider` and puts the server beside it', async () => {
		const primary = failing('primary', 401)
		const fallback = new MockLLMProvider({ turns: [{ text: 'ok' }] })

		const run = await drainQuery({
			...baseParams(primary, new ToolRegistry(), await mkWorkdir()),
			fallbackProviders: [{ provider: fallback, model: 'fallback-model' }],
			messages: [createUserMessage('hello')],
		})

		// Two facts that differ, and both are kept. Overwriting `provider` would
		// lose what the operator configured; leaving it alone was what made the
		// record wrong.
		expect(run.metadata.provider).toBe('primary')
		expect(run.metadata.servingProvider).toBe(fallback.id)
	})

	it('names the serving member when no step can say who served', async () => {
		const primary = failing('primary', 401)
		const secondary = failing('secondary', 503)

		const run = await drainQuery({
			...baseParams(primary, new ToolRegistry(), await mkWorkdir()),
			fallbackProviders: [{ provider: secondary }],
			messages: [createUserMessage('hello')],
		})

		// Nothing served, so no step can carry `servedBy` — which is exactly the
		// case `metadata.servingProvider` exists for. The run still has to be
		// able to say whose failure ended it.
		//
		// This used to assert an EMPTY ledger, and that assertion was only ever
		// true because a failed iteration recorded nothing at all. The failing
		// turn now leaves a step like every other turn does, so the premise is
		// restated where it actually holds: the step exists and is silent about
		// provenance, because the chain was exhausted before anyone answered.
		expect(run.status).toBe('failed')
		expect(run.steps ?? []).toHaveLength(1)
		expect(run.steps?.[0]?.servedBy).toBeUndefined()
		expect(run.steps?.[0]?.finishReason).toBe('error')
		expect(run.metadata.servingProvider).toBe('secondary')
	})

	it('carries the swap forward to later steps, which emit no notice of their own', async () => {
		// Turn 1 is served by the primary and calls a tool; turn 2 fails and the
		// chain advances; turns 2 and 3 are the fallback's. Only turn 2 has a
		// notice chunk, so turn 3 is the step a record built from the stream
		// alone gets wrong.
		const primary = healthyThenFailing('primary', 1, 401)
		const fallback = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'f1', name: 'echo', rawArguments: '{}' }] },
				{ toolCalls: [{ id: 'f2', name: 'echo', rawArguments: '{}' }] },
				{ text: 'done' },
			],
		})
		const tools = new ToolRegistry()
		registerEcho(tools)

		const run = await drainQuery({
			...baseParams(primary, tools, await mkWorkdir(), 4),
			fallbackProviders: [{ provider: fallback, model: 'fallback-model' }],
			messages: [createUserMessage('hello')],
		})

		// Four steps for four iterations, including the answering turn — which
		// is the one whose provenance nothing could see before it became a step.
		expect(run.steps?.map((s) => s.servedBy?.providerId)).toEqual([
			'primary',
			fallback.id,
			fallback.id,
			fallback.id,
		])
		expect(run.steps?.map((s) => s.servedBy?.model)).toEqual([
			'primary-model',
			'fallback-model',
			'fallback-model',
			'fallback-model',
		])
	})

	it('records the declared provider on a run with no chain, rather than nothing', async () => {
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ id: 'c1', name: 'echo', rawArguments: '{}' }] }, { text: 'ok' }],
		})
		const tools = new ToolRegistry()
		registerEcho(tools)

		const run = await drainQuery({
			...baseParams(provider, tools, await mkWorkdir(), 2),
			messages: [createUserMessage('hello')],
		})

		// Written even when it agrees with the head. A ledger that carries the
		// fact only when it is surprising cannot be read as evidence: absence
		// would mean both "the head served" and "nobody wrote it down".
		expect(run.steps?.[0]?.servedBy).toEqual({
			providerId: provider.id,
			model: 'primary-model',
			chainIndex: 0,
		})
		// Absence here is the statement "the declared provider served every
		// call", so a run that never fell over must not carry it.
		expect(run.metadata.servingProvider).toBeUndefined()
	})

	it("records the model the STEP asked for, not the run's", async () => {
		// No chain anywhere in this case. The ledger took the run's model while
		// the request took `step.model ?? model` from the line above it, so a
		// host routing one step to a cheaper model read the expensive one back.
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'echo', rawArguments: '{}' }] },
				{ toolCalls: [{ id: 'c2', name: 'echo', rawArguments: '{}' }] },
				{ text: 'done' },
			],
		})
		const tools = new ToolRegistry()
		registerEcho(tools)

		const run = await drainQuery({
			...baseParams(provider, tools, await mkWorkdir(), 3),
			prepareStep: ({ stepNumber }: { stepNumber: number }) =>
				stepNumber === 2 ? { model: 'cheap-model' } : {},
			messages: [createUserMessage('hello')],
		})

		// The third entry is the answering turn, which asked for the run's model
		// because `prepareStep` only overrode step 2.
		expect(run.steps?.map((s) => s.model)).toEqual([
			'primary-model',
			'cheap-model',
			'primary-model',
		])
		// And the same correction reaches the provenance, because a member
		// declared without a model serves whatever the step asked for.
		expect(run.steps?.map((s) => s.servedBy?.model)).toEqual([
			'primary-model',
			'cheap-model',
			'primary-model',
		])
	})
})
