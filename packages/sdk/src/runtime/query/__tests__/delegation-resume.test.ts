import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionLog } from '../../../store/session-log/index.js'
import type { CheckpointId } from '../../../types/hitl/index.js'
import type { TurnId } from '../../../types/ids/index.js'
import { createAssistantMessage, createUserMessage } from '../../../types/message/index.js'
import type { Message } from '../../../types/message/index.js'
import type { Logger } from '../../../utils/logger.js'
import type { RestoredCheckpoint } from '../checkpoint.js'
import { planCrashResume, recoverCompletedCalls } from '../resume-pending.js'
import { type CheckpointedSession, sessionWithCheckpoint } from './support/session.js'

/**
 * A fan-out that crashes part-way through must not re-run the workers that
 * already finished — for a worker with a side effect, a write or an
 * outbound message, "run it again" is "do it twice".
 *
 * The claim under test is that this is ALREADY covered, and by a general
 * mechanism rather than a delegation-specific one. Delegation here is
 * blocking: the tool awaits its worker and returns that worker's output as
 * its own `tool_result`. So a delegation is an ordinary tool call, its
 * completion is recorded as an ordinary `tool_completed` record, and the
 * crash-resume path that answers already-executed tool calls from the
 * transcript answers delegations too.
 *
 * These tests exist because that is a load-bearing consequence of an
 * unrelated design choice, and nothing pinned it. If delegation ever stops
 * blocking, they fail — which is exactly when somebody needs to know.
 */

const RID = '37ddff8e-e13f-4e57-937f-d048fa323f5e' as TurnId

function makeLogger(): Logger {
	const self = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
	;(self as { child: (ctx: unknown) => Logger }).child = vi.fn(() => self)
	return self
}

const delegation = (id: string, agent: string) => ({
	id,
	type: 'function' as const,
	function: { name: 'create_task', arguments: JSON.stringify({ agent_id: agent }) },
})

/** A five-worker fan-out: one assistant turn, five delegation blocks. */
const fanOut = (): Message[] => [
	createUserMessage('fan out to five specialists'),
	{
		...createAssistantMessage(''),
		toolCalls: [
			delegation('w1', 'writer'),
			delegation('w2', 'auditor'),
			delegation('w3', 'billing'),
			delegation('w4', 'mailer'),
			delegation('w5', 'reporter'),
		],
	} as Message,
]

describe('a fan-out interrupted part-way through', () => {
	let session: CheckpointedSession

	beforeEach(async () => {
		session = await sessionWithCheckpoint({ turnId: RID, messages: fanOut() })
	})

	/** The workers' completions, recorded in the turn as the process ran them. */
	const recordCompletions = async (ids: readonly string[]) => {
		for (const id of ids) {
			await session.log.append(session.lease, {
				type: 'tool_completed',
				turnId: RID,
				toolUseId: id,
				toolName: 'create_task',
				result: `${id} finished its work`,
				isError: false,
			} as Parameters<SessionLog['append']>[1])
		}
	}

	/** The recorder side recovery reads: the turn's log. */
	const recorder = () => ({ log: session.log, turnId: RID, flush: async () => {} }) as never

	const restored = (): RestoredCheckpoint =>
		({
			id: '62d8ff8a-122d-4369-8274-e1f1dc479c1c' as CheckpointId,
			messages: fanOut(),
			messageIds: new Map(),
		}) as unknown as RestoredCheckpoint

	it('recovers the workers that already finished', async () => {
		await recordCompletions(['w1', 'w2', 'w3'])

		const recovered = await recoverCompletedCalls(
			recorder(),
			(fanOut()[1] as { toolCalls: { id: string }[] }).toolCalls as never,
			makeLogger(),
		)

		// Three workers are answered from the record. The billing worker in
		// particular does not charge a second time.
		expect([...recovered.keys()].sort()).toEqual(['w1', 'w2', 'w3'])
		expect(recovered.get('w3')?.result).toContain('finished its work')
	})

	it('takes over the turn rather than letting the model re-decide', async () => {
		// The ordinary repair strips the assistant turn and lets the model
		// re-issue every delegation — which is precisely the second run.
		const plan = planCrashResume(restored(), new Map([['w1', {}]]), makeLogger())

		expect(plan).not.toBeNull()
		expect(plan?.response.message.toolCalls).toHaveLength(5)
	})

	it('names the workers that will actually run', async () => {
		const log = makeLogger()
		planCrashResume(
			restored(),
			new Map([
				['w1', {}],
				['w2', {}],
				['w3', {}],
			]),
			log,
		)

		const warned = (log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
		expect(warned?.[1]).toMatchObject({
			'namzu.runtime.recovered': 3,
			'namzu.runtime.total': 5,
		})
	})

	it('leaves an untouched fan-out to the ordinary repair', async () => {
		// Nothing dispatched yet means nothing to protect, and re-deciding
		// costs only a round trip.
		expect(planCrashResume(restored(), new Map(), makeLogger())).toBeNull()
	})

	it('does not confuse a worker id with one from an earlier turn', async () => {
		await recordCompletions(['from-an-older-turn'])

		const recovered = await recoverCompletedCalls(
			recorder(),
			(fanOut()[1] as { toolCalls: { id: string }[] }).toolCalls as never,
			makeLogger(),
		)

		// Scoped to the calls being resumed, so a stale id cannot answer a
		// delegation that never ran.
		expect(recovered.size).toBe(0)
	})
})
