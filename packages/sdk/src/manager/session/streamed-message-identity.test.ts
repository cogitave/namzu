import { expect, it, vi } from 'vitest'
import { memorySession, records } from '../../runtime/query/__tests__/support/session.js'
import { EventTranslator } from '../../runtime/query/events.js'
import { createAssistantMessage } from '../../types/message/index.js'
import { generateMessageId, generateTurnId } from '../../utils/id.js'
import { withStreamedMessageIdentity } from './streamed-message-identity.js'
import { TurnRecorder } from './turn-recorder.js'

it('records only trusted stream identities and ignores caller-authored message IDs', async () => {
	const session = memorySession()
	const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }
	log.child.mockReturnValue(log)
	const recorder = new TurnRecorder({
		...session,
		turnId: generateTurnId(),
		agentId: 'identity-test',
		agentName: 'Identity test',
		turnConfig: { model: 'mock', tokenBudget: 0, timeoutMs: 0 },
		providerId: 'mock',
		log,
	})
	await recorder.open({ session: { cwd: '/tmp' } })
	try {
		await new EventTranslator(recorder).beginTurn({})
		recorder.markRunning()
		const hostile = generateMessageId()
		const ordinary = { ...createAssistantMessage('Same text'), id: hostile }
		const captured = generateMessageId()
		const streamed = withStreamedMessageIdentity(
			{ ...createAssistantMessage('Same text'), id: hostile },
			captured,
		)
		recorder.pushMessage(ordinary)
		recorder.pushMessage(streamed)
		await recorder.flush()
		const messages = (await records(session.sessionLog)).filter(
			(record) => record.type === 'message',
		)
		expect(messages).toHaveLength(2)
		expect(messages.map((record) => record.messageId)).not.toContain(hostile)
		expect(messages[0]?.messageId).not.toBe(captured)
		expect(messages[1]?.messageId).toBe(captured)
		expect(ordinary.id).toBe(messages[0]?.messageId)
		expect(streamed.id).toBe(captured)
	} finally {
		await recorder.release()
	}
})

it('does not strongly index message objects and preserves their recorded IDs after compaction', async () => {
	const session = memorySession()
	const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }
	log.child.mockReturnValue(log)
	const recorder = new TurnRecorder({
		...session,
		turnId: generateTurnId(),
		agentId: 'identity-retention-test',
		agentName: 'Identity retention test',
		turnConfig: { model: 'mock', tokenBudget: 0, timeoutMs: 0 },
		providerId: 'mock',
		log,
	})
	await recorder.open({ session: { cwd: '/tmp' } })
	try {
		await new EventTranslator(recorder).beginTurn({})
		recorder.markRunning()
		const historical = createAssistantMessage('Historical message')
		const historicalId = generateMessageId()
		const fresh = createAssistantMessage('New message')
		// Observe only insertion, not compaction's short-lived lookup maps. This
		// deterministically guards the strong retention root without GC timing.
		const strongInsertions = vi.spyOn(Map.prototype, 'set')
		let stronglyIndexed: boolean
		try {
			recorder.pushMessage(historical, { messageId: historicalId })
			recorder.pushMessage(fresh)
			stronglyIndexed = strongInsertions.mock.calls.some(
				([key]) => key === historical || key === fresh,
			)
		} finally {
			strongInsertions.mockRestore()
		}
		await recorder.flush()
		const freshId = recorder.recordedIdOf(fresh)
		expect(freshId).toBeDefined()
		recorder.replaceMessages([createAssistantMessage('Compacted summary')])
		await recorder.flush()
		expect(recorder.recordedIdOf(historical)).toBe(historicalId)
		expect(recorder.recordedIdOf(fresh)).toBe(freshId)
		expect(stronglyIndexed).toBe(false)
	} finally {
		await recorder.release()
	}
})
