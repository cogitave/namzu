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
