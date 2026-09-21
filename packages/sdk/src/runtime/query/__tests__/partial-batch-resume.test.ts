import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ActivityStore } from '../../../store/activity/memory.js'
import type { SessionLog } from '../../../store/session-log/index.js'
import type { CheckpointId } from '../../../types/hitl/index.js'
import type { SessionId, TurnId } from '../../../types/ids/index.js'
import {
	type Message,
	createAssistantMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { ToolRegistryContract } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import type { RestoredCheckpoint } from '../checkpoint.js'
import { ToolExecutor } from '../executor.js'
import { interruptedToolCalls, planCrashResume } from '../resume-pending.js'
import { readToolExecutions } from '../tool-executions.js'
import { type CheckpointedSession, sessionWithCheckpoint } from './support/session.js'

/**
 * A batch's results reach the history only when the WHOLE batch settles,
 * so a hard kill part-way through loses every result that had already come
 * back — and the resumed run re-executes those calls. For a `write_file`
 * that is waste; for a payment or an email it is a second one.
 *
 * Nothing new had to be recorded to fix it. The executor already awaits a
 * `tool_completed` per tool, inline, carrying the id, the name, the result
 * and the error flag, and the session log already records it. The record
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

function checkpointWith(messages: Message[]): RestoredCheckpoint {
	return {
		id: '62d8ff8a-122d-4369-8274-e1f1dc479c1c' as CheckpointId,
		messages,
		messageIds: new Map(),
	} as unknown as RestoredCheckpoint
}

const parkedBatch = (): Message[] => [
	createUserMessage('charge the customer and email them'),
	{
		...createAssistantMessage(''),
		toolCalls: [call('t1', 'charge_card'), call('t2', 'send_email')],
	} as Message,
]

describe('reading completed calls back out of the session log', () => {
	const TURN = '37ddff8e-e13f-4e57-937f-d048fa323f5e' as TurnId
	let session: CheckpointedSession

	beforeEach(async () => {
		session = await sessionWithCheckpoint({ turnId: TURN })
	})

	const append = async (drafts: Record<string, unknown>[]) => {
		for (const draft of drafts) {
			await session.log.append(session.lease, {
				turnId: TURN,
				...draft,
			} as Parameters<SessionLog['append']>[1])
		}
	}

	const read = (ids: readonly string[] = ['t1', 't2']) => readToolExecutions(session.log, TURN, ids)

	it('recovers the calls that finished', async () => {
		await append([
			{ type: 'tool_executing', toolUseId: 't1', toolName: 'charge_card', input: {} },
			{
				type: 'tool_completed',
				toolUseId: 't1',
				toolName: 'charge_card',
				result: 'charged',
				isError: false,
			},
		])

		const { records, complete } = await read()
		expect(complete).toBe(true)
		expect(records.get('t1')).toEqual({
			toolUseId: 't1',
			toolName: 'charge_card',
			status: 'completed',
			result: 'charged',
			isError: false,
		})
		// The one that never finished must NOT be invented — it still has to
		// run, and claiming otherwise would drop the work silently.
		expect(records.has('t2')).toBe(false)
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

		expect((await read()).records.get('t1')).toMatchObject({ result: 'ok' })
	})

	it('treats a start with no completion as a call whose outcome is unknown', async () => {
		// The shape a process killed mid-tool leaves: started, never finished.
		await append([{ type: 'tool_executing', toolUseId: 't2', toolName: 'send_email', input: {} }])

		expect((await read()).records.get('t2')).toEqual({
			toolUseId: 't2',
			toolName: 'send_email',
			status: 'started',
		})
	})

	it('returns nothing when the turn recorded no tool calls', async () => {
		const { records, complete } = await read()
		expect(records.size).toBe(0)
		// Complete: the turn's beginning was read, so absence is proof.
		expect(complete).toBe(true)
	})

	it('is not complete for a turn the log never began', async () => {
		const { complete } = await readToolExecutions(
			session.log,
			'4f1b0f65-8a47-4d71-9d7c-8c1f2f0f9a01' as TurnId,
			['t1'],
		)
		expect(complete).toBe(false)
	})

	it('refuses a completion missing the fields that identify a call', async () => {
		await append([{ type: 'tool_completed', result: 'orphan', isError: false }])
		await expect(read()).rejects.toThrow(/invalid tool identity/)
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
		expect(warned?.[1]).toMatchObject({
			'namzu.runtime.recovered': 1,
			'namzu.runtime.total': 2,
			'namzu.runtime.remaining': ['send_email'],
		})
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

	it('leaves an abandoned batch before a newer operator message to history repair', () => {
		const messages = [...parkedBatch(), createUserMessage('stop charging; check the account')]
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
				sessionId: 'b8a2f2e1-5f0e-4a8d-9f76-1c2f3e4d5a6b' as SessionId,
				turnId: '37ddff8e-e13f-4e57-937f-d048fa323f5e' as TurnId,
				workingDirectory: tmpdir(),
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
			},
			new ActivityStore('37ddff8e-e13f-4e57-937f-d048fa323f5e' as TurnId, {
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
	it('includes answered siblings because the resumed executor reconstructs the whole batch', () => {
		const messages: Message[] = [
			...parkedBatch(),
			{ role: 'tool', content: 'charged', toolCallId: 't1' } as Message,
		]
		expect(interruptedToolCalls(messages).map((tc) => tc.id)).toEqual(['t1', 't2'])
	})

	it('does not let a result before or after the immediate batch answer by global id', () => {
		const before: Message[] = [
			{ role: 'tool', content: 'too early', toolCallId: 't1' } as Message,
			...parkedBatch(),
		]
		const displaced: Message[] = [
			...parkedBatch(),
			createUserMessage('a later turn started'),
			{ role: 'tool', content: 'too late', toolCallId: 't1' } as Message,
		]

		expect(interruptedToolCalls(before).map((tc) => tc.id)).toEqual(['t1', 't2'])
		expect(interruptedToolCalls(displaced).map((tc) => tc.id)).toEqual(['t1', 't2'])
	})

	it('is empty when the history holds no tool calls at all', () => {
		expect(interruptedToolCalls([createUserMessage('hello')])).toEqual([])
	})
})
