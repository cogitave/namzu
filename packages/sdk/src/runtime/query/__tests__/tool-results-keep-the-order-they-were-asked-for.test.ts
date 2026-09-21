import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import { defineTool } from '../../../tools/defineTool.js'
import { autoApproveHandler } from '../../../types/hitl/index.js'
import type { TurnId } from '../../../types/ids/index.js'
import type { Message } from '../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolExecutor } from '../executor.js'
import { type QueryParams, drainQuery } from '../index.js'

const SESSION_ID = generateSessionId()

/**
 * The invariant is POSITIONAL, not temporal: a batch's `results[i]` and
 * `messages[i]` belong to the call at `toolCalls[i]`, however the calls
 * happened to interleave.
 *
 * Every existing multi-call ordering test uses tools that resolve
 * immediately, or share one latch so they resume in registration order — so
 * `results[i] = …` and `results.push(…)` are indistinguishable under all of
 * them. The pair below is the one that tells them apart: the SECOND call
 * resolves FIRST, so a positional write keeps call order and a push swaps
 * the answers the model reads back.
 */

const mockTurnId = '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as TurnId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function latch() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function workdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-tool-order-'))
	dirs.push(dir)
	return dir
}

/** One assistant turn asking for `calls` in the order given. */
function batchOf(calls: ReadonlyArray<{ id: string; name: string }>): ChatCompletionResponse {
	return {
		message: {
			role: 'assistant',
			content: null,
			toolCalls: calls.map((call) => ({
				id: call.id,
				type: 'function' as const,
				function: { name: call.name, arguments: '{}' },
			})),
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

interface ExecutorFixture {
	executor: ToolExecutor
	events: SessionEvent[]
}

function executorOver(tools: ToolRegistry): ExecutorFixture {
	const events: SessionEvent[] = []
	const executor = new ToolExecutor(
		{
			sessionId: SESSION_ID,
			tools,
			turnId: mockTurnId,
			workingDirectory: '/tmp',
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
		},
		new ActivityStore(mockTurnId, { enabled: true, trackToolCalls: true, trackLlmTurns: true }),
		async (event) => {
			events.push(event as SessionEvent)
		},
		makeLogger(),
	)
	return { executor, events }
}

/**
 * The `toolCallId` of every message, insisting they ARE tool results.
 *
 * A batch's messages are all `tool` role by construction, and saying so is
 * worth the line: a mapping that silently returned `undefined` for anything
 * else would let an inserted assistant turn pass as an ordered batch.
 */
function toolResultIds(messages: readonly Message[]): string[] {
	return messages.map((message) => {
		if (message.role !== 'tool') {
			throw new Error(`the batch produced a ${message.role} message, not a tool result`)
		}
		return message.toolCallId
	})
}

/** Every `tool_executing` / `tool_completed` as `[type, toolUseId]`. */
const toolEventPairs = (events: readonly SessionEvent[]) =>
	events
		.filter((event) => event.type === 'tool_executing' || event.type === 'tool_completed')
		.map((event) => [
			event.type,
			(event as Extract<SessionEvent, { type: 'tool_executing' }>).toolUseId,
		])

describe('a batch whose calls finish in the opposite order to the one they were asked in', () => {
	/**
	 * `first` waits for `second` to finish. `done` records the real completion
	 * order, so the premise ("the second one really did come back first") is
	 * asserted rather than assumed.
	 */
	function reversedPair() {
		const done: string[] = []
		const secondFinished = latch()
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'first',
				description: 'asked for first, answers last',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async () => {
					await secondFinished.promise
					done.push('first')
					return { success: true, output: 'FIRST' }
				},
			}),
		)
		tools.register(
			defineTool({
				name: 'second',
				description: 'asked for second, answers first',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async () => {
					done.push('second')
					secondFinished.resolve()
					return { success: true, output: 'SECOND' }
				},
			}),
		)
		return { tools, done }
	}

	it('answers each tool_use with its OWN result, in call order', async () => {
		const { tools, done } = reversedPair()
		const { executor } = executorOver(tools)

		const batch = await executor.executeBatch(
			batchOf([
				{ id: 'call_first', name: 'first' },
				{ id: 'call_second', name: 'second' },
			]),
		)

		// The premise: completion order really is the reverse of call order.
		expect(done).toEqual(['second', 'first'])

		// The claim. A positional write keeps call order; a `push` would hand
		// the model SECOND's answer under FIRST's `tool_use_id` — and a
		// `tool_result` carrying the wrong id is a malformed turn, not a
		// cosmetic mix-up.
		expect(batch.results.map((result) => [result.toolCallId, result.output])).toEqual([
			['call_first', 'FIRST'],
			['call_second', 'SECOND'],
		])
		expect(toolResultIds(batch.messages)).toEqual(['call_first', 'call_second'])
		expect(batch.messages.map((message) => message.content)).toEqual(['FIRST', 'SECOND'])
	})

	it('reports the executions in the order they actually completed', async () => {
		const { tools } = reversedPair()
		const { executor, events } = executorOver(tools)

		await executor.executeBatch(
			batchOf([
				{ id: 'call_first', name: 'first' },
				{ id: 'call_second', name: 'second' },
			]),
		)

		// The temporal stream is NOT positional and must not be made so: a UI
		// that renders a card per `tool_completed` is showing what happened,
		// and every start is announced before any completion because both
		// calls begin together.
		expect(toolEventPairs(events)).toEqual([
			['tool_executing', 'call_first'],
			['tool_executing', 'call_second'],
			['tool_completed', 'call_second'],
			['tool_completed', 'call_first'],
		])
	})

	it('keeps call order for a batch larger than two, whatever the completion order', async () => {
		const finished: string[] = []
		const gates = new Map([
			['charlie', latch()],
			['bravo', latch()],
			['alpha', latch()],
		])
		const tools = new ToolRegistry()
		for (const [name, output] of [
			['alpha', 'A'],
			['bravo', 'B'],
			['charlie', 'C'],
		] as const) {
			const mine = gates.get(name) as ReturnType<typeof latch>
			tools.register(
				defineTool({
					name,
					description: name,
					inputSchema: z.object({}),
					category: 'custom',
					permissions: [],
					readOnly: true,
					destructive: false,
					concurrencySafe: true,
					execute: async () => {
						// Each call waits for the one asked for AFTER it, so the
						// whole batch completes in exactly reverse order.
						const next = name === 'alpha' ? gates.get('bravo') : gates.get('charlie')
						if (name !== 'charlie') await next?.promise
						finished.push(name)
						mine.resolve()
						return { success: true, output }
					},
				}),
			)
		}
		const { executor } = executorOver(tools)

		const batch = await executor.executeBatch(
			batchOf([
				{ id: 'call_a', name: 'alpha' },
				{ id: 'call_b', name: 'bravo' },
				{ id: 'call_c', name: 'charlie' },
			]),
		)

		expect(finished).toEqual(['charlie', 'bravo', 'alpha'])
		expect(batch.results.map((result) => result.toolCallId)).toEqual(['call_a', 'call_b', 'call_c'])
		expect(toolResultIds(batch.messages)).toEqual(['call_a', 'call_b', 'call_c'])
		expect(batch.messages.map((message) => message.content)).toEqual(['A', 'B', 'C'])
	})
})

describe('a tool that must not run beside anything else', () => {
	function pair(options: { barrier: boolean }) {
		const order: string[] = []
		const held = latch()
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'mutate',
				description: 'changes shared state',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: false,
				destructive: true,
				concurrencySafe: true,
				executionBarrier: options.barrier,
				execute: async () => {
					order.push('mutate:start')
					await held.promise
					order.push('mutate:end')
					return { success: true, output: 'mutated' }
				},
			}),
		)
		tools.register(
			defineTool({
				name: 'inspect',
				description: 'reads shared state',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async () => {
					order.push('inspect:start')
					order.push('inspect:end')
					return { success: true, output: 'inspected' }
				},
			}),
		)
		return { tools, order, held }
	}

	it('is not overtaken by a later safe sibling when it declares an execution barrier', async () => {
		const { tools, order, held } = pair({ barrier: true })
		const { executor } = executorOver(tools)

		const pending = executor.executeBatch(
			batchOf([
				{ id: 'call_mutate', name: 'mutate' },
				{ id: 'call_inspect', name: 'inspect' },
			]),
		)
		// The mutator is mid-flight and the reader has not been started: that
		// is the guarantee the barrier exists for, and it is about the
		// SEQUENCE, so asserting it here rather than after both settled is
		// what makes the test about overtaking at all.
		await vi.waitFor(() => expect(order).toEqual(['mutate:start']))
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(order).toEqual(['mutate:start'])

		held.resolve()
		await pending
		expect(order).toEqual(['mutate:start', 'mutate:end', 'inspect:start', 'inspect:end'])
	})

	it('is still overtaken by a later safe sibling when it only declines concurrency', async () => {
		// Measured, not assumed, and pinned because it is surprising: a
		// `concurrencySafe: false` tool is serialized against OTHER unsafe
		// calls, not against safe ones. The safe sibling starts while it is
		// still running, and the overlap is the documented legacy behaviour
		// (`executor-concurrency.test.ts` calls it out by name) rather than an
		// accident of scheduling — so a refactor that quietly turned this into
		// a full barrier would change what a read observes.
		const order: string[] = []
		const held = latch()
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'mutate',
				description: 'changes shared state',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: false,
				destructive: true,
				concurrencySafe: false,
				execute: async () => {
					order.push('mutate:start')
					await held.promise
					order.push('mutate:end')
					return { success: true, output: 'mutated' }
				},
			}),
		)
		tools.register(
			defineTool({
				name: 'inspect',
				description: 'reads shared state',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async () => {
					order.push('inspect:start')
					order.push('inspect:end')
					return { success: true, output: 'inspected' }
				},
			}),
		)
		const { executor } = executorOver(tools)

		const pending = executor.executeBatch(
			batchOf([
				{ id: 'call_mutate', name: 'mutate' },
				{ id: 'call_inspect', name: 'inspect' },
			]),
		)
		await vi.waitFor(() => expect(order).toContain('inspect:end'))
		held.resolve()
		const batch = await pending

		expect(order).toEqual(['mutate:start', 'inspect:start', 'inspect:end', 'mutate:end'])
		// And the overlap does not disturb the positions, which is the whole
		// point: the invocation boundary is ordering, not exclusion.
		expect(batch.results.map((result) => result.toolCallId)).toEqual([
			'call_mutate',
			'call_inspect',
		])
	})
})

describe('a real run that asked for two tools at once', () => {
	function concurrentRegistry() {
		const finished: string[] = []
		const secondFinished = latch()
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'alpha',
				description: 'asked for first, answers last',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async () => {
					await secondFinished.promise
					finished.push('alpha')
					return { success: true, output: 'ALPHA-OUT' }
				},
			}),
		)
		tools.register(
			defineTool({
				name: 'beta',
				description: 'asked for second, answers first',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async () => {
					finished.push('beta')
					secondFinished.resolve()
					return { success: true, output: 'BETA-OUT' }
				},
			}),
		)
		return { tools, finished }
	}

	async function runBoth(): Promise<{
		events: SessionEvent[]
		run: Awaited<ReturnType<typeof drainQuery>>
	}> {
		const { tools } = concurrentRegistry()
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{ id: 'call_a', name: 'alpha', args: {} },
						{ id: 'call_b', name: 'beta', args: {} },
					],
					finishReason: 'tool_calls',
				},
				{ text: 'both came back' },
			],
		})
		const events: SessionEvent[] = []
		const run = await drainQuery(
			{
				provider,
				tools,
				agentId: 'agent_tool_order',
				agentName: 'Tool order agent',
				messages: [{ role: 'user', content: 'go' }],
				workingDirectory: await workdir(),
				turnConfig: {
					model: 'mock',
					timeoutMs: 20_000,
					tokenBudget: 100_000,
					maxIterations: 4,
					maxResponseTokens: 256,
				},
				projectId: generateProjectId(),
				sessionId: generateSessionId(),
				topicId: generateTopicId(),
				tenantId: generateTenantId(),
				resumeHandler: autoApproveHandler,
			} as unknown as QueryParams,
			(event) => {
				events.push(event as SessionEvent)
			},
		)
		return { events, run }
	}

	it('records both results against their own tool_use, directly after the assistant turn', async () => {
		// The `result immediately follows its owner assistant message`
		// property is asserted elsewhere only on the repair and durable-resume
		// paths. It holds on FRESH execution too, and the provider rejects the
		// next request when it does not.
		const { run } = await runBoth()

		const roles = run.messages.map((message) => message.role)
		const assistantAt = roles.indexOf('assistant')
		expect(run.messages[assistantAt + 1]).toMatchObject({ role: 'tool', toolCallId: 'call_a' })
		expect(run.messages[assistantAt + 2]).toMatchObject({ role: 'tool', toolCallId: 'call_b' })
		expect(run.messages[assistantAt + 3]).toMatchObject({ role: 'assistant' })
		expect(roles.slice(assistantAt)).toEqual(['assistant', 'tool', 'tool', 'assistant'])
	})

	it('numbers every durable event in log order while the batch interleaves', async () => {
		// `EventTranslator` appends under a lock, and the docblock on the lock
		// names "a batch of parallel tools" as one of the interleavers it
		// exists for. This drives the production interleaver through a real
		// run. An event's number is its record's `seq` in the session log,
		// which also holds message records, so the numbers climb with gaps.
		const { events } = await runBoth()

		const numbered = events.filter((event) => event.seq !== undefined).map((e) => e.seq as number)
		expect(numbered.length).toBeGreaterThan(10)
		expect(numbered).toEqual([...numbered].sort((a, b) => a - b))
		// A duplicated number is worse than a missing one — a consumer asking
		// for everything above N is handed part of the run it already had.
		expect(new Set(numbered).size).toBe(numbered.length)
	})

	it('announces both tool starts before the first completion', async () => {
		const { events } = await runBoth()

		// The same interleaving the executor produces, but seen from the run:
		// `tool_executing` for both, then the completions in the order they
		// really came back. Only the starts were ever asserted anywhere.
		expect(toolEventPairs(events)).toEqual([
			['tool_executing', 'call_a'],
			['tool_executing', 'call_b'],
			['tool_completed', 'call_b'],
			['tool_completed', 'call_a'],
		])
	})
})

describe('the ordering a nested dispatch sees', () => {
	it('gives every sibling the batch id of the call that opened the batch', async () => {
		const tools = new ToolRegistry()
		const batchIds: Array<string | undefined> = []
		for (const name of ['one', 'two']) {
			tools.register(
				defineTool({
					name,
					description: name,
					inputSchema: z.object({}),
					category: 'custom',
					permissions: [],
					readOnly: true,
					destructive: false,
					concurrencySafe: true,
					execute: async (_input: unknown, context: ToolContext) => {
						batchIds.push(context.toolBatchId)
						return { success: true, output: name }
					},
				}),
			)
		}
		const { executor } = executorOver(tools)

		await executor.executeBatch(
			batchOf([
				{ id: 'call_one', name: 'one' },
				{ id: 'call_two', name: 'two' },
			]),
		)

		// Keyed off the FIRST call id, not the last one to be prepared. The
		// batch id is what a host groups concurrent siblings by, so a
		// preparation pass that reordered the calls would split one batch's
		// cards across two groups.
		expect(batchIds).toEqual([
			JSON.stringify([String(mockTurnId), 'call_one']),
			JSON.stringify([String(mockTurnId), 'call_one']),
		])
	})
})
