import { expect, it, vi } from 'vitest'
import { memorySession, records } from '../../../runtime/query/__tests__/support/session.js'
import { EventTranslator } from '../../../runtime/query/events.js'
import { foldSessionMessages } from '../../../store/session-log/fold.js'
import type { MessageId, TurnId } from '../../../types/ids/index.js'
import {
	type AssistantMessage,
	type Message,
	createAssistantMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import { generateCheckpointId, generateTurnId } from '../../../utils/id.js'
import { TurnRecorder } from '../turn-recorder.js'

/**
 * A turn resumed in a new process restores the context a checkpoint holds, and
 * pushes it with the ids the log gave it. After a compaction edit the log folds
 * to the edited text, so the resumed recorder must neither re-record the
 * context (the ids match) nor leave the fold showing text the context does not
 * hold.
 */

const NARRATION = 'The step is done. '.repeat(80)
const STUB = 'The step is done. (elided; 1,400 characters of narration)'

function recorderFor(session: ReturnType<typeof memorySession>, turnId: TurnId) {
	const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }
	log.child.mockReturnValue(log)
	return new TurnRecorder({
		...session,
		turnId,
		agentId: 'resume-test',
		agentName: 'Resume test',
		turnConfig: { model: 'mock', tokenBudget: 0, timeoutMs: 0 },
		providerId: 'mock',
		log,
	})
}

async function firstProcess() {
	const session = memorySession()
	const turnId = generateTurnId()
	const rec = recorderFor(session, turnId)
	await rec.open({ session: { cwd: '/tmp' } })
	await new EventTranslator(rec).beginTurn({})
	rec.markRunning()
	const context: Message[] = [createUserMessage('go')]
	for (let i = 0; i < 6; i++) context.push(createAssistantMessage(`${NARRATION}${i}`))
	for (const message of context) rec.pushMessage(message)
	await rec.flush()
	return { session, turnId, rec, context }
}

/** A new process: a new recorder on the same log, the turn resumed with `restored`. */
async function secondProcess(
	session: ReturnType<typeof memorySession>,
	turnId: TurnId,
	restored: readonly Message[],
) {
	const rec = recorderFor(session, turnId)
	await rec.open({ session: { cwd: '/tmp' } })
	await rec.resume(generateCheckpointId())
	for (const message of restored) rec.pushMessage(message, { messageId: message.id as MessageId })
	return rec
}

const typesAfter = async (session: ReturnType<typeof memorySession>, from: number) =>
	(await records(session.sessionLog)).slice(from).map((r) => r.type)

it('resumes on the edited context without writing anything for it', async () => {
	const { session, turnId, rec, context } = await firstProcess()
	const edited = [...context]
	edited[3] = { ...(edited[3] as AssistantMessage), content: STUB }
	rec.replaceMessages(edited)
	await rec.flush()
	await rec.release()
	const before = (await records(session.sessionLog)).length

	const resumed = await secondProcess(
		session,
		turnId,
		edited.map((m) => ({ ...m })),
	)
	try {
		resumed.pushMessage(createUserMessage('and then?'))
		await resumed.flush()
		// The resume itself, then only the new message: nothing for the restored
		// messages or the edit.
		expect(await typesAfter(session, before)).toEqual(['turn_resuming', 'message'])
	} finally {
		await resumed.release()
	}
})

it('puts the edit back when the checkpoint predates it and the context keeps the original text', async () => {
	const { session, turnId, rec, context } = await firstProcess()
	const edited = [...context]
	edited[3] = { ...(edited[3] as AssistantMessage), content: STUB }
	rec.replaceMessages(edited)
	await rec.flush()
	await rec.release()
	const before = (await records(session.sessionLog)).length

	// The context a checkpoint written before the edit restores: the original text.
	const resumed = await secondProcess(
		session,
		turnId,
		context.map((m) => ({ ...m })),
	)
	try {
		resumed.pushMessage(createUserMessage('and then?'))
		await resumed.flush()
		expect(await typesAfter(session, before)).toEqual([
			'turn_resuming',
			'message_edited',
			'message',
		])
		const fold = await foldSessionMessages(
			(await session.sessionLog.readAll()).entries.map((e) => e.record),
		)
		expect((fold[3] as AssistantMessage).content).toBe(`${NARRATION}2`)
		expect(fold).toHaveLength(context.length + 1)
	} finally {
		await resumed.release()
	}
})
