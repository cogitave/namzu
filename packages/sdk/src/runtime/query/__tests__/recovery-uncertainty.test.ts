import { expect, it, vi } from 'vitest'
import type { SessionLog } from '../../../store/session-log/index.js'
import type { TurnId } from '../../../types/ids/index.js'
import { generateTurnId } from '../../../utils/id.js'
import type { Logger } from '../../../utils/logger.js'
import { PendingAnswers } from '../question-park.js'
import { recoverCompletedCalls } from '../resume-pending.js'
import { type CheckpointedSession, sessionWithCheckpoint } from './support/session.js'

const calls = ['done', 'unknown', 'untouched'].map((id) => ({
	id,
	type: 'function' as const,
	function: { name: 'effect', arguments: '{}' },
}))
const log = { warn: vi.fn(), info: vi.fn() } as unknown as Logger

/**
 * A turn whose log holds a completed `done`, a `unknown` that started and
 * never finished, and no record of `untouched`.
 */
async function interruptedBatch(
	completed: { toolName?: string } = {},
): Promise<CheckpointedSession> {
	const session = await sessionWithCheckpoint()
	const append = (draft: Record<string, unknown>) =>
		session.log.append(session.lease, {
			turnId: session.turnId,
			...draft,
		} as Parameters<SessionLog['append']>[1])
	await append({ type: 'tool_executing', toolUseId: 'done', toolName: 'effect', input: {} })
	await append({
		type: 'tool_completed',
		toolUseId: 'done',
		toolName: completed.toolName ?? 'effect',
		result: 'actual receipt',
		isError: false,
	})
	await append({ type: 'tool_executing', toolUseId: 'unknown', toolName: 'effect', input: {} })
	return session
}

/** The recorder side recovery reads: a log and the turn it is resuming. */
function recorder(sessionLog: SessionLog, turnId: TurnId) {
	return { log: sessionLog, turnId, flush: async () => {} } as never
}

it('keeps real completions, marks starts unknown, and leaves proven unstarted calls eligible', async () => {
	const session = await interruptedBatch()
	const recovered = await recoverCompletedCalls(recorder(session.log, session.turnId), calls, log)
	expect(recovered.get('done')).toEqual({ result: 'actual receipt', isError: false })
	expect(recovered.get('unknown')).toMatchObject({
		result: expect.stringContaining('outcome is unknown'),
		isError: true,
	})
	expect(recovered.has('untouched')).toBe(false)
})

it.each(['unavailable', 'incomplete', 'wrong-name'] as const)(
	'does not mistake %s evidence for permission to repeat',
	async (mode) => {
		const session = await interruptedBatch(mode === 'wrong-name' ? { toolName: 'other_tool' } : {})
		const source =
			mode === 'unavailable'
				? ({
						...session.log,
						read: () => {
							throw new Error('read failed')
						},
					} as unknown as SessionLog)
				: session.log
		// A turn the log never began: its records cannot prove anything absent.
		const turnId = mode === 'incomplete' ? generateTurnId() : session.turnId
		const recovered = await recoverCompletedCalls(recorder(source, turnId), calls, log)
		expect(recovered.get('done')?.result).toContain('outcome is unknown')
		expect(recovered.get('done')?.result).not.toContain('actual receipt')
		if (mode === 'unavailable' || mode === 'incomplete') expect(recovered.size).toBe(3)
	},
)

it("reads only the resumed turn's records", async () => {
	// Another turn of the session ran a call with the same id; its receipt is
	// not this turn's.
	const session = await sessionWithCheckpoint()
	await session.log.append(session.lease, {
		type: 'tool_completed',
		turnId: session.turnId,
		toolUseId: 'unknown',
		toolName: 'effect',
		result: 'this turn',
		isError: false,
	} as Parameters<SessionLog['append']>[1])
	const recovered = await recoverCompletedCalls(recorder(session.log, session.turnId), calls, log)
	expect([...recovered.keys()]).toEqual(['unknown'])
	expect(recovered.get('unknown')?.result).toBe('this turn')
})

it('lets an explicit durable answer re-enter only its asking tool when the log is unavailable', async () => {
	const session = await interruptedBatch()
	const answers = PendingAnswers.from({
		action: 'answer_question',
		questionId: 'unknown:target',
		selectedOptionIds: ['yes'],
	})
	const unavailable = {
		...session.log,
		read: () => {
			throw new Error('unavailable')
		},
	} as unknown as SessionLog
	const recovered = await recoverCompletedCalls(recorder(unavailable, session.turnId), calls, log, {
		answers,
	})
	expect(recovered.has('unknown')).toBe(false)
	expect(recovered.has('done')).toBe(true)
	expect(recovered.has('untouched')).toBe(true)
})

it('preserves cancellation instead of synthesizing recovery permission', async () => {
	const session = await interruptedBatch()
	const signal = AbortSignal.abort(new Error('cancelled'))
	await expect(
		recoverCompletedCalls(recorder(session.log, session.turnId), calls, log, { signal }),
	).rejects.toThrow('cancelled')
})
