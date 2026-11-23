import { expect, it, vi } from 'vitest'
import { memorySession, records } from '../../../runtime/query/__tests__/support/session.js'
import { EventTranslator } from '../../../runtime/query/events.js'
import type { TurnId } from '../../../types/ids/index.js'
import {
	type Message,
	createAssistantMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import { generateTurnId } from '../../../utils/id.js'
import { TurnRecorder } from '../turn-recorder.js'

/**
 * A session whose context was compacted keeps its summary in one `compaction`
 * record. A later turn restores that summary into its context; it must not
 * write the same text again as a second record at its start.
 */

type Session = ReturnType<typeof memorySession>

function recorderFor(session: Session, turnId: TurnId) {
	const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }
	log.child.mockReturnValue(log)
	return new TurnRecorder({
		...session,
		turnId,
		agentId: 'summary-test',
		agentName: 'Summary test',
		turnConfig: { model: 'mock', tokenBudget: 0, timeoutMs: 0 },
		providerId: 'mock',
		log,
	})
}

const SUMMARY = (): Message =>
	({
		role: 'system',
		content: 'Summary of the earlier work.',
		source: { type: 'compaction-summary' },
		timestamp: 2,
	}) as Message

const compactions = async (session: Session) =>
	(await records(session.sessionLog)).filter((record) => record.type === 'compaction')

async function compactedSession() {
	const session = memorySession()
	const rec = recorderFor(session, generateTurnId())
	await rec.open({ session: { cwd: '/tmp' } })
	await new EventTranslator(rec).beginTurn({})
	rec.markRunning()
	const first = createUserMessage('start')
	const second = createAssistantMessage('step')
	const third = createUserMessage('go on')
	for (const message of [first, second, third]) rec.pushMessage(message)
	await rec.flush()
	// The context is rewritten: the first message becomes a summary.
	rec.replaceMessages([SUMMARY(), second, third])
	await rec.flush()
	await rec.release()
	return session
}

async function nextTurn(session: Session): Promise<TurnRecorder> {
	const rec = recorderFor(session, generateTurnId())
	const history = await rec.open({ session: { cwd: '/tmp' } })
	for (const entry of history) {
		rec.pushMessage(entry.message, {
			...(entry.messageId ? { messageId: entry.messageId } : {}),
			restored: true,
		})
	}
	await new EventTranslator(rec).beginTurn({ abandonInterrupted: true })
	rec.markRunning()
	await rec.flush()
	return rec
}

it('a turn that restores the folded summary writes no second compaction record', async () => {
	const session = await compactedSession()
	expect(await compactions(session)).toHaveLength(1)
	const rec = await nextTurn(session)
	expect(await compactions(session)).toHaveLength(1)
	rec.pushMessage(createUserMessage('and one more'))
	await rec.flush()
	expect(await compactions(session)).toHaveLength(1)
	await rec.release()
	// And the turn after that one still finds the same context.
	const again = await nextTurn(session)
	expect(await compactions(session)).toHaveLength(1)
	await again.release()
})

it('a summary the log does not hold is still recorded', async () => {
	const session = await compactedSession()
	const rec = recorderFor(session, generateTurnId())
	const history = await rec.open({ session: { cwd: '/tmp' } })
	const changed = { ...SUMMARY(), content: 'A different summary.' } as Message
	rec.pushMessage(changed, { restored: true })
	for (const entry of history.filter((item) => item.messageId)) {
		rec.pushMessage(entry.message, { messageId: entry.messageId as never, restored: true })
	}
	await new EventTranslator(rec).beginTurn({ abandonInterrupted: true })
	rec.markRunning()
	await rec.flush()
	expect(await compactions(session)).toHaveLength(2)
	await rec.release()
})
