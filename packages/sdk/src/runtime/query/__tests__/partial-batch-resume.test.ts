import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ActivityStore } from '../../../store/activity/memory.js'
import { RunDiskStore } from '../../../store/run/disk.js'
import type { CheckpointId, IterationCheckpoint } from '../../../types/hitl/index.js'
import type { RunId } from '../../../types/ids/index.js'
import {
	type Message,
	createAssistantMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { ToolRegistryContract } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolExecutor } from '../executor.js'
import { planCrashResume, unansweredToolCalls } from '../resume-pending.js'

/**
 * A batch's results reach the history only when the WHOLE batch settles,
 * so a hard kill part-way through loses every result that had already come
 * back — and the resumed run re-executes those calls. For a `write_file`
 * that is waste; for a payment or an email it is a second one.
 *
 * Nothing new had to be recorded to fix it. The executor already awaits a
 * `tool_completed` per tool, inline, carrying the id, the name, the result
 * and the error flag, and the transcript already persists it. The record
 * was durable all along and simply never read back.
 */

function makeLogger(): Logger {
	const self = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
	;(self as { child: (ctx: unknown) => Logger }).child = vi.fn(() => self)
	return self
}

const call = (id: string, name: string) => ({
	id,
	type: 'function' as const,
	function: { name, arguments: '{}' },
})

function checkpointWith(messages: Message[]): IterationCheckpoint {
	return { id: 'cp_1' as CheckpointId, messages } as IterationCheckpoint
}

const parkedBatch = (): Message[] => [
	createUserMessage('charge the customer and email them'),
	{
		...createAssistantMessage(''),
		toolCalls: [call('t1', 'charge_card'), call('t2', 'send_email')],
	} as Message,
]

describe('reading completed calls back out of the transcript', () => {
	let dir: string
	let store: RunDiskStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'namzu-resume-'))
		store = new RunDiskStore({ baseDir: dir })
		await store.initRun('run_1')
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	const append = async (lines: unknown[]) => {
		await writeFile(
			join(dir, 'run_1', 'transcript.jsonl'),
			`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
			'utf-8',
		)
	}

	it('recovers the calls that finished', async () => {
		await append([
			{ type: 'tool_executing', toolUseId: 't1', toolName: 'charge_card' },
			{
				type: 'tool_completed',
				toolUseId: 't1',
				toolName: 'charge_card',
				result: 'charged',
				isError: false,
			},
		])

		const completed = await store.readCompletedTools()
		expect(completed.get('t1')).toEqual({
			toolUseId: 't1',
			toolName: 'charge_card',
			result: 'charged',
			isError: false,
		})
		// The one that never finished must NOT be invented — it still has to
		// run, and claiming otherwise would drop the work silently.
		expect(completed.has('t2')).toBe(false)
	})

	it('keeps the last result when a tool was retried', async () => {
		await append([
			{
				type: 'tool_completed',
				toolUseId: 't1',
				toolName: 'fetch',
				result: 'timeout',
				isError: true,
			},
			{ type: 'tool_completed', toolUseId: 't1', toolName: 'fetch', result: 'ok', isError: false },
		])

		expect((await store.readCompletedTools()).get('t1')?.result).toBe('ok')
	})

	it('survives the torn last line a killed process leaves behind', async () => {
		// This is the ordinary shape of a file that was being appended to
		// when the process died — which is the exact case being recovered.
		await writeFile(
			join(dir, 'run_1', 'transcript.jsonl'),
			`${JSON.stringify({ type: 'tool_completed', toolUseId: 't1', toolName: 'a', result: 'r', isError: false })}\n{"type":"tool_com`,
			'utf-8',
		)

		const completed = await store.readCompletedTools()
		expect(completed.size).toBe(1)
	})

	it('returns nothing when the run never wrote a transcript', async () => {
		expect((await store.readCompletedTools()).size).toBe(0)
	})

	it('ignores an event missing the fields that identify a call', async () => {
		await append([{ type: 'tool_completed', result: 'orphan', isError: false }])
		expect((await store.readCompletedTools()).size).toBe(0)
	})
})

describe('planning the resume of a part-executed batch', () => {
	it('takes over when some calls already ran', () => {
		const messages = parkedBatch()
		const plan = planCrashResume(checkpointWith(messages), new Map([['t1', {}]]), makeLogger())

		expect(plan).not.toBeNull()
		// The assistant turn is kept, not stripped: the results about to be
		// produced have to answer the `tool_use` blocks that are in it.
		expect(plan?.response.message.toolCalls).toHaveLength(2)
		expect(plan?.denials.size).toBe(0)
	})

	it('leaves an untouched batch to the ordinary repair', () => {
		// A tool-review park records the checkpoint BEFORE any execution, so
		// nothing completed and re-deciding costs only a round trip. Taking
		// it over here would execute calls a human had not answered yet.
		expect(planCrashResume(checkpointWith(parkedBatch()), new Map(), makeLogger())).toBeNull()
	})

	it('says which calls are about to run for the first time', () => {
		const log = makeLogger()
		planCrashResume(checkpointWith(parkedBatch()), new Map([['t1', {}]]), log)

		const warned = (log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
		expect(warned?.[1]).toMatchObject({ completed: 1, total: 2, remaining: ['send_email'] })
	})

	it('does nothing when the turn is fully answered', () => {
		const messages: Message[] = [
			...parkedBatch(),
			{ role: 'tool', content: 'charged', toolCallId: 't1' } as Message,
			{ role: 'tool', content: 'sent', toolCallId: 't2' } as Message,
		]
		expect(
			planCrashResume(checkpointWith(messages), new Map([['t1', {}]]), makeLogger()),
		).toBeNull()
	})
})

describe('executing a batch that carries recovered results', () => {
	const response = {
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [call('t1', 'charge_card'), call('t2', 'send_email')],
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as never

	async function runBatch(prior?: ReadonlyMap<string, { result: string; isError: boolean }>) {
		const execute = vi.fn(async () => ({ success: true, output: 'freshly executed' }))
		const tools = {
			register: vi.fn(),
			unregister: vi.fn(),
			execute,
			get: vi.fn(() => ({ isConcurrencySafe: () => true })),
			has: vi.fn(() => true),
			listNames: vi.fn(() => []),
			getAvailability: vi.fn(),
		} as unknown as ToolRegistryContract

		const executor = new ToolExecutor(
			{
				tools,
				runId: 'run_1' as RunId,
				workingDirectory: tmpdir(),
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
			},
			new ActivityStore('run_1' as RunId, {
				enabled: false,
				trackToolCalls: false,
				trackLlmTurns: false,
			}),
			async () => {},
			makeLogger(),
		)

		const batch = await executor.executeBatch(response, undefined, prior)
		return { batch, execute }
	}

	it('does not run a tool that already ran', async () => {
		const { batch, execute } = await runBatch(
			new Map([['t1', { result: 'charged $40', isError: false }]]),
		)

		// The whole point: charging the card twice is the failure.
		expect(execute).toHaveBeenCalledTimes(1)
		expect(batch.results.find((r) => r.toolCallId === 't1')?.output).toBe('charged $40')
	})

	it('still runs the calls that never completed', async () => {
		const { batch } = await runBatch(new Map([['t1', { result: 'charged', isError: false }]]))
		expect(batch.results.find((r) => r.toolCallId === 't2')?.output).toBe('freshly executed')
		// Every `tool_use` block is answered, in the original order.
		expect(batch.results.map((r) => r.toolCallId)).toEqual(['t1', 't2'])
	})

	it('preserves a recovered failure as a failure', async () => {
		const { batch } = await runBatch(new Map([['t1', { result: 'declined', isError: true }]]))
		expect(batch.results.find((r) => r.toolCallId === 't1')?.isError).toBe(true)
	})

	it('runs everything when nothing was recovered', async () => {
		const { execute } = await runBatch()
		expect(execute).toHaveBeenCalledTimes(2)
	})
})

describe('which calls are worth asking about', () => {
	it('is only the unanswered ones', () => {
		const messages: Message[] = [
			...parkedBatch(),
			{ role: 'tool', content: 'charged', toolCallId: 't1' } as Message,
		]
		expect(unansweredToolCalls(messages).map((tc) => tc.id)).toEqual(['t2'])
	})

	it('is empty when the history holds no tool calls at all', () => {
		expect(unansweredToolCalls([createUserMessage('hello')])).toEqual([])
	})
})
