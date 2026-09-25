import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/index.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import { InMemorySessionLog, type SessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { SessionId, TenantId, TurnId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { SessionEvent } from '../../../types/session/index.js'
import type { SessionRecord } from '../../../types/session/records.js'
import type { ToolContext, ToolResult } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import type { SessionEventDraft } from '../events.js'
import { ToolExecutor } from '../executor.js'
import { query } from '../index.js'
import { ToolCallBudget } from '../tool-call-budget.js'
import { sessionWithCheckpoint } from './support/session.js'

const turnId = 'e2d37322-06f5-48ad-9575-2f16bd7bb972' as TurnId
const sessionId = '4a71d2e5-6938-4d6c-a221-d6a65306e4cc' as SessionId

/** The turn's records as the executor reads them back. */
type Ledger = (SessionEvent | SessionRecord)[]
const dirs: string[] = []
afterEach(async () => {
	for (const dir of dirs.splice(0)) await removeTempDirAsync(dir)
})

function response(...names: string[]): ChatCompletionResponse {
	return {
		id: 'response',
		model: 'mock',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: names.map((name, i) => ({
				id: `c${i}`,
				type: 'function',
				function: { name, arguments: '{}' },
			})),
		},
		finishReason: 'tool_calls',
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
	}
}

function definitions(
	run: (name: string, context: ToolContext) => Promise<ToolResult>,
	maxRetries = 0,
) {
	return ['one', 'two', 'three'].map((name) =>
		defineTool({
			name,
			description: name,
			inputSchema: z.object({}),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			maxRetries,
			execute: (_input, context) => run(name, context),
		}),
	)
}

function registry(
	run: (name: string, context: ToolContext) => Promise<ToolResult>,
	maxRetries = 0,
): ToolManager {
	return new ToolManager({
		toolsets: [testToolset(...definitions(run, maxRetries))],
		messages: () => [],
	})
}

function harness(
	tools: ToolManager,
	limit?: number,
	options: {
		signal?: AbortSignal
		events?: Ledger
		emit?: (event: SessionEventDraft) => Promise<void>
		read?: () => Promise<readonly SessionRecord[]>
	} = {},
) {
	const events: Ledger = options.events ?? [{ type: 'turn_started', turnId, seq: 1 } as never]
	const emit =
		options.emit ??
		(async (event: SessionEventDraft) => {
			events.push({ ...event, seq: events.length + 1 } as never)
		})
	const log = {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child: () => log,
	} as unknown as Logger
	const executor = new ToolExecutor(
		{
			tools,
			sessionId,
			turnId,
			workingDirectory: '/tmp',
			env: {},
			permissionMode: 'auto',
			abortSignal: options.signal ?? new AbortController().signal,
			...(limit === undefined
				? {}
				: {
						maxToolCalls: limit,
						readToolCallBudgetRecords:
							options.read ?? (async () => [...events] as unknown as SessionRecord[]),
					}),
			toolRetryBackoff: { initialDelayMs: 0 },
		},
		new ActivityStore(turnId, { enabled: false, trackToolCalls: false, trackLlmTurns: false }),
		emit,
		log,
	)
	return { executor, events }
}

const successful = async () => ({ success: true, output: 'ok' })

describe('cumulative tool-call admission', () => {
	it('refuses the whole three-call batch when only two slots remain', async () => {
		const run = vi.fn(successful)
		const { executor, events } = harness(registry(run), 3)
		await executor.executeBatch(response('one'))
		const refused = await executor.executeBatch(response('one', 'two', 'three'))
		expect(run).toHaveBeenCalledTimes(1)
		expect(refused.results).toHaveLength(3)
		expect(
			refused.results.every((result) => result.isError && result.output.includes('2 remain')),
		).toBe(true)
		expect(
			events.filter((event) => event.type === 'tool_calls_admitted').map((event) => event.used),
		).toEqual([0, 1])
	})

	it('keeps unset unlimited and zero a real no-tool limit', async () => {
		const run = vi.fn(successful)
		const unlimited = harness(registry(run))
		await unlimited.executor.executeBatch(response('one', 'two', 'three'))
		expect(run).toHaveBeenCalledTimes(3)
		expect(unlimited.events.some((event) => event.type === 'tool_calls_admitted')).toBe(false)
		const zero = harness(registry(run), 0)
		expect((await zero.executor.executeBatch(response('one'))).results[0]?.isError).toBe(true)
		expect(run).toHaveBeenCalledTimes(3)
	})

	it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		'rejects invalid limit %s upfront',
		(limit) => {
			expect(() => harness(registry(successful), limit)).toThrow(/nonnegative safe integer/)
		},
	)

	it('counts retry attempts and refuses the next retry without running it', async () => {
		const run = vi.fn(async () => ({
			success: false,
			output: '',
			error: 'transient',
			retryable: true,
		}))
		const { executor, events } = harness(registry(run, 5), 2)
		const result = await executor.executeBatch(response('one'))
		expect(run).toHaveBeenCalledTimes(2)
		expect(result.results[0]?.output).toContain('budget exhausted')
		expect(
			events.filter((event) => event.type === 'tool_calls_admitted').map((event) => event.used),
		).toEqual([0, 1, 2])
	})

	it('serializes concurrent nested admissions against the same parent budget', async () => {
		const nested: ToolResult[] = []
		const calls: string[] = []
		const tools = registry(async (name, context) => {
			calls.push(name)
			if (name === 'one')
				nested.push(
					...(await Promise.all([
						context.dispatchTool?.('two', {}) as Promise<ToolResult>,
						context.dispatchTool?.('two', {}) as Promise<ToolResult>,
						context.dispatchTool?.('three', {}) as Promise<ToolResult>,
					])),
				)
			return successful()
		})
		await harness(tools, 3).executor.executeBatch(response('one'))
		expect(calls).toEqual(['one', 'two', 'two'])
		expect(nested.map((result) => result.success)).toEqual([true, true, false])
		expect(nested[2]?.error).toContain('budget exhausted')
	})

	it('does not refund denied reservations or reset allowance when the executor reopens', async () => {
		const run = vi.fn(successful)
		const tools = registry(run)
		const first = harness(tools, 1)
		await first.executor.executeBatch(response('one'), new Map([['c0', 'operator refusal']]))
		const reopened = harness(tools, 1, { events: first.events })
		const denied = await reopened.executor.executeBatch(response('two'))
		expect(run).not.toHaveBeenCalled()
		expect(denied.results[0]?.output).toContain('0 remain')
	})

	it('persists admission before a cancelled batch and retains its slots on recovery', async () => {
		const controller = new AbortController()
		const events: Ledger = [{ type: 'turn_started', turnId, seq: 1 } as never]
		const run = vi.fn(successful)
		const first = harness(registry(run), 2, {
			signal: controller.signal,
			events,
			emit: async (event) => {
				events.push({ ...event, seq: events.length + 1 } as never)
				if (event.type === 'tool_calls_admitted' && event.kind === 'batch')
					controller.abort(new Error('cancel after reservation'))
			},
		})
		await expect(first.executor.executeBatch(response('one', 'two'))).rejects.toThrow(
			'cancel after reservation',
		)
		expect(run).not.toHaveBeenCalled()
		const next = await harness(registry(run), 2, { events }).executor.executeBatch(response('one'))
		expect(next.results[0]?.output).toContain('0 remain')
	})

	it('fails closed on unreadable or inconsistent recovery evidence', async () => {
		// Contiguity and integrity are the log's: it is read strictly. What the
		// ledger checks is that this turn's records add up.
		const run = vi.fn(successful)
		const start = { type: 'turn_started', turnId, seq: 1 } as unknown as SessionRecord
		for (const read of [
			async (): Promise<SessionRecord[]> => {
				throw new Error('log unavailable')
			},
			async () => [
				start,
				{
					type: 'tool_calls_admitted',
					turnId,
					seq: 2,
					kind: 'batch',
					count: 1,
					used: 1,
					limit: 3,
				} as unknown as SessionRecord,
			],
			async () => [
				start,
				{
					type: 'tool_executing',
					turnId,
					seq: 2,
					toolUseId: 'c9',
					toolName: 'one',
				} as unknown as SessionRecord,
			],
		]) {
			await expect(
				harness(registry(run), 3, { read }).executor.executeBatch(response('one')),
			).rejects.toThrow()
		}
		expect(run).not.toHaveBeenCalled()
	})

	it("does not count another turn's admissions against this one", async () => {
		const run = vi.fn(successful)
		const other = {
			type: 'tool_calls_admitted',
			turnId: '9d3b2a17-4c6e-4b5f-8a1d-2e3f4a5b6c7d',
			seq: 2,
			kind: 'initialize',
			count: 0,
			used: 0,
			limit: 1,
		} as unknown as SessionRecord
		const result = await harness(registry(run), 1, {
			read: async () => [other],
		}).executor.executeBatch(response('one'))
		expect(run).toHaveBeenCalledTimes(1)
		expect(result.results[0]?.isError).toBe(false)
	})

	it('refuses oversized replay and a ledger write failure before any body executes', async () => {
		const run = vi.fn(successful)
		await expect(
			harness(registry(run), 3, {
				read: async () =>
					new Array(100_001).fill({ type: 'turn_started', turnId, seq: 1 }) as SessionRecord[],
			}).executor.executeBatch(response('one')),
		).rejects.toThrow(/100000/)
		const broken = harness(registry(run), 3, {
			emit: async () => {
				throw new Error('cannot persist admission')
			},
		})
		await expect(broken.executor.executeBatch(response('one'))).rejects.toThrow(
			'cannot persist admission',
		)
		await expect(broken.executor.executeBatch(response('one'))).rejects.toThrow(
			'cannot persist admission',
		)
		expect(run).not.toHaveBeenCalled()
	})

	it('reads a durable ledger after restart and does not recharge completed-call recovery', async () => {
		const session = await sessionWithCheckpoint({ turnId, sessionId })
		const emit = async (event: SessionEventDraft) => {
			const {
				seq: _seq,
				generation: _generation,
				sessionId: _session,
				...draft
			} = event as Record<string, unknown>
			await session.log.append(
				session.lease,
				draft as unknown as Parameters<SessionLog['append']>[1],
			)
		}
		const readFrom = (log: SessionLog) => async () =>
			(await log.readAll({ mode: 'strict' })).entries.map((entry) => entry.record)
		const ledger = new ToolCallBudget(2, turnId, emit, readFrom(session.log))
		await ledger.admit(2, 'batch', new AbortController().signal)
		await emit({
			type: 'tool_completed',
			turnId,
			toolUseId: 'c0',
			toolName: 'one',
			result: 'already completed',
			isError: false,
		} as SessionEvent)
		// Crash after one result; both original slots remain reserved. Another
		// instance of the log is what the next process reads.
		const reopened = new InMemorySessionLog({
			sessionId,
			medium: session.log.medium,
			leases: session.log.leaseStore,
			spills: session.log.spillStore,
		})
		const run = vi.fn(successful)
		const recovered = harness(registry(run), 2, { emit, read: readFrom(reopened) })
		const result = await recovered.executor.executeBatch(
			response('one', 'two'),
			undefined,
			new Map([['c0', { result: 'already completed', isError: false }]]),
		)
		expect(result.results[0]?.output).toBe('already completed')
		expect(result.results[1]?.output).toContain('0 remain')
		expect(run).not.toHaveBeenCalled()
		expect(
			(await readFrom(reopened)())
				.filter((record) => record.type === 'tool_calls_admitted')
				.map((record) => (record as { used?: number }).used),
		).toEqual([0, 2])
	})

	it('wires cumulative admission through real query turns', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-query-call-budget-'))
		dirs.push(workingDirectory)
		const run = vi.fn(successful)
		const events: SessionEvent[] = []
		for await (const event of query({
			provider: new MockLLMProvider({
				turns: [
					{ toolCalls: [{ id: 'first', name: 'one', args: {} }], finishReason: 'tool_calls' },
					{
						toolCalls: ['one', 'two', 'three'].map((name, i) => ({
							id: `next${i}`,
							name,
							args: {},
						})),
						finishReason: 'tool_calls',
					},
					{ text: 'Stopped at the tool budget.' },
				],
			}),
			toolsets: [testToolset(...definitions(run))],
			maxToolCalls: 3,
			turnConfig: { model: 'mock', timeoutMs: 10_000, tokenBudget: 100_000, maxIterations: 4 },
			agentId: 'budget',
			agentName: 'Budget',
			messages: [createUserMessage('perform work')],
			workingDirectory,
			sessionId,
			topicId: '02a7b973-2f51-4205-aa5f-caa1cb02b6b6' as TopicId,
			projectId: 'f73faf9a-a270-4e43-90a1-51e1e7d55ae6' as ProjectId,
			tenantId: '1e8f97a6-c551-4a9a-83b0-dc8de7a5174b' as TenantId,
			resumeHandler: async () => ({ action: 'continue' }),
		}))
			events.push(event as SessionEvent)
		expect(run).toHaveBeenCalledTimes(1)
		expect(events.some((event) => event.type === 'turn_completed')).toBe(true)
		expect(events.filter((event) => event.type === 'tool_completed' && event.isError)).toHaveLength(
			3,
		)
	})
})
