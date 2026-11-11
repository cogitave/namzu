import { expect, it, vi } from 'vitest'
import { clearToolResult } from '../../../compaction/tool-result-editing.js'
import { memorySession, records } from '../../../runtime/query/__tests__/support/session.js'
import { EventTranslator } from '../../../runtime/query/events.js'
import { foldSessionMessages } from '../../../store/session-log/fold.js'
import type { SessionLog } from '../../../store/session-log/index.js'
import type { MessageId } from '../../../types/ids/index.js'
import {
	type AssistantMessage,
	type Message,
	type ToolMessage,
	createAssistantMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { SessionRecord } from '../../../types/session/records.js'
import { generateTurnId } from '../../../utils/id.js'
import { TurnRecorder } from '../turn-recorder.js'

/**
 * A compaction pass edits a message by swapping its object for a copy with
 * other content (`{ ...message, content }`). The copy still carries the
 * message's id but no entry in the recorder's identity indexes, so the
 * recorder used to treat every message after it as new and record each again,
 * under a fresh id, behind a `compaction` record. A pass that edits k messages
 * must append O(k) small records, whatever the context holds.
 *
 * Every count below is a count of appended records, never a time or a size.
 */

const NARRATION = 'The step is done. '.repeat(80)
const STUB = 'The step is done. (elided; 1,400 characters of narration)'

function toolMessage(callId: string, content: string): ToolMessage {
	return { role: 'tool', toolCallId: callId, content, timestamp: 1 }
}

function turnOf(callId: string): Message[] {
	const call = {
		...createAssistantMessage(''),
		toolCalls: [{ id: callId, type: 'function', function: { name: 'bash', arguments: '{}' } }],
	} as AssistantMessage
	return [call, toolMessage(callId, 'x'.repeat(4000)), createAssistantMessage(NARRATION)]
}

async function recorder() {
	const session = memorySession()
	const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }
	log.child.mockReturnValue(log)
	const rec = new TurnRecorder({
		...session,
		turnId: generateTurnId(),
		agentId: 'edit-test',
		agentName: 'Edit test',
		turnConfig: { model: 'mock', tokenBudget: 0, timeoutMs: 0 },
		providerId: 'mock',
		log,
	})
	await rec.open({ session: { cwd: '/tmp' } })
	await new EventTranslator(rec).beginTurn({})
	rec.markRunning()
	return { rec, session }
}

/** A context of `turns` turns of three messages each, every one recorded. */
async function recordedContext(turns: number) {
	const made = await recorder()
	const context: Message[] = [createUserMessage('go')]
	for (let turn = 0; turn < turns; turn++) context.push(...turnOf(`call-${turn}`))
	for (const message of context) made.rec.pushMessage(message)
	await made.rec.flush()
	return { ...made, context }
}

const counts = (all: readonly SessionRecord[], from: number) => {
	const out: Record<string, number> = {}
	for (const record of all.slice(from)) out[record.type] = (out[record.type] ?? 0) + 1
	return out
}

/** What a reader folds from the log, as the context the turn holds. */
async function folded(session: { sessionLog: SessionLog }) {
	return foldSessionMessages((await session.sessionLog.readAll()).entries.map((e) => e.record))
}

for (const turns of [10, 40]) {
	it(`a pass that stubs three narrations and clears two results appends five records (${turns} turns)`, async () => {
		const { rec, session, context } = await recordedContext(turns)
		try {
			const before = (await records(session.sessionLog)).length
			const next = [...context]
			const idsBefore = context.map((m) => m.id)
			for (const at of [3, 6, 9]) next[at] = { ...(next[at] as AssistantMessage), content: STUB }
			for (const at of [2, 5]) next[at] = clearToolResult(next[at] as ToolMessage, 'bash').message
			rec.replaceMessages(next)
			await rec.flush()
			const all = await records(session.sessionLog)
			// Five edits and nothing else: no compaction, no message again.
			expect(counts(all, before)).toEqual({ message_edited: 5 })
			expect(next.map((m) => m.id)).toEqual(idsBefore)
			// What a reader folds is the context the turn holds, ids and all.
			expect(await folded(session)).toEqual(next)
		} finally {
			await rec.release()
		}
	})
}

it('keeps what an edit replaced: the message record and its text are still in the log', async () => {
	const { rec, session, context } = await recordedContext(4)
	try {
		const original = context[3] as AssistantMessage
		const next = [...context]
		next[3] = { ...original, content: STUB }
		rec.replaceMessages(next)
		await rec.flush()
		const all = await records(session.sessionLog)
		const first = all.find((r) => r.type === 'message' && r.messageId === original.id)
		expect(first && first.type === 'message' && first.content.content).toBe(NARRATION)
		const edit = all.find((r) => r.type === 'message_edited')
		expect(edit?.type === 'message_edited' && edit.targetMessageId).toBe(original.id)
		expect(edit?.type === 'message_edited' && edit.ignorable).toBe(true)
	} finally {
		await rec.release()
	}
})

it('one edit per pass over many passes keeps the appended records proportional to the edits', async () => {
	const appended: Record<number, number> = {}
	for (const turns of [8, 32]) {
		const { rec, session, context } = await recordedContext(turns)
		try {
			const before = (await records(session.sessionLog)).length
			let live = [...context]
			// Each "turn" adds three messages then one pass stubs the oldest narration.
			for (let turn = 0; turn < 6; turn++) {
				for (const message of turnOf(`late-${turn}`)) {
					live.push(message)
					rec.pushMessage(message)
				}
				const at = live.findIndex(
					(m) => m.role === 'assistant' && m.content === NARRATION && !m.toolCalls,
				)
				live = [...live]
				live[at] = { ...(live[at] as AssistantMessage), content: STUB }
				rec.replaceMessages(live)
			}
			await rec.flush()
			const all = await records(session.sessionLog)
			// Six turns of three new messages, six edits, whatever the history held.
			expect(counts(all, before)).toEqual({ message: 18, message_edited: 6 })
			appended[turns] = all.length - before
			expect(await folded(session)).toEqual(live)
		} finally {
			await rec.release()
		}
	}
	expect(appended[32]).toBe(appended[8])
})

it('a pass that also summarises the head still appends one compaction and the edits', async () => {
	for (const turns of [8, 32]) {
		const { rec, session, context } = await recordedContext(turns)
		try {
			const before = (await records(session.sessionLog)).length
			const summary: Message = {
				role: 'system',
				content: 'Summary of the earlier work.',
				source: { type: 'compaction-summary' },
				timestamp: 2,
			} as Message
			// The head is replaced by a summary; the recent tail is kept and two of
			// its messages are edited in the same pass.
			const kept = context.slice(-12)
			const next: Message[] = [summary, ...kept]
			next[2] = { ...(next[2] as AssistantMessage), content: STUB }
			next[5] = { ...(next[5] as AssistantMessage), content: STUB }
			rec.replaceMessages(next)
			await rec.flush()
			const all = await records(session.sessionLog)
			expect(counts(all, before)).toEqual({ message_edited: 2, compaction: 1 })
			const compaction = all.slice(before).find((r) => r.type === 'compaction')
			expect(compaction?.type === 'compaction' && compaction.summary).toHaveLength(1)
			expect(compaction?.type === 'compaction' && compaction.keptMessageIds).toHaveLength(12)
			expect(await folded(session)).toEqual(next.map((m, i) => (i === 0 ? { ...m } : m)))
		} finally {
			await rec.release()
		}
	}
})

it('a copy that is not the same message still takes the old path', async () => {
	const { rec, session, context } = await recordedContext(4)
	try {
		const before = (await records(session.sessionLog)).length
		const next = [...context]
		const { id: _dropped, ...withoutId } = next[3] as AssistantMessage
		next[3] = { ...withoutId, content: STUB }
		rec.replaceMessages(next)
		await rec.flush()
		const kinds = counts(await records(session.sessionLog), before)
		expect(kinds.message_edited).toBeUndefined()
		expect(kinds.compaction).toBe(1)
		expect(kinds.message).toBe(next.length - 3)
	} finally {
		await rec.release()
	}
})

it('two copies of one message are never both its edit', async () => {
	const { rec, session, context } = await recordedContext(4)
	try {
		const before = (await records(session.sessionLog)).length
		const next = [...context]
		const original = next[3] as AssistantMessage
		next[3] = { ...original, content: STUB }
		next.splice(4, 0, { ...original, content: `${STUB} again` })
		rec.replaceMessages(next)
		await rec.flush()
		const kinds = counts(await records(session.sessionLog), before)
		expect(kinds.message_edited).toBeUndefined()
		expect(kinds.compaction).toBe(1)
	} finally {
		await rec.release()
	}
})

it('a fold read through an earlier seq does not see an edit written later', async () => {
	const { rec, session, context } = await recordedContext(4)
	try {
		const seq = (await records(session.sessionLog)).length
		const next = [...context]
		next[3] = { ...(next[3] as AssistantMessage), content: STUB }
		rec.replaceMessages(next)
		await rec.flush()
		const all = (await session.sessionLog.readAll()).entries.map((e) => e.record)
		const early = await foldSessionMessages(all, { throughSeq: seq })
		expect((early[3] as AssistantMessage).content).toBe(NARRATION)
		expect(((await foldSessionMessages(all))[3] as AssistantMessage).content).toBe(STUB)
		expect(MESSAGE_IDS(early)).toEqual(MESSAGE_IDS(await foldSessionMessages(all)))
	} finally {
		await rec.release()
	}
})

function MESSAGE_IDS(messages: readonly Message[]): (MessageId | undefined)[] {
	return messages.map((m) => m.id)
}

it('an earlier release, which skips the flagged record, folds the unedited conversation', async () => {
	const { rec, session, context } = await recordedContext(4)
	try {
		const next = [...context]
		next[3] = { ...(next[3] as AssistantMessage), content: STUB }
		rec.replaceMessages(next)
		await rec.flush()
		const all = (await session.sessionLog.readAll()).entries.map((e) => e.record)
		// Every edit is flagged: the promise that a reader can do without it.
		const edits = all.filter((r) => r.type === 'message_edited')
		expect(edits).toHaveLength(1)
		expect(edits.every((r) => r.ignorable === true)).toBe(true)
		// A reader that skips it holds the same conversation with the original text
		// of the edited message, in the same order and under the same ids.
		const older = await foldSessionMessages(all.filter((r) => r.type !== 'message_edited'))
		expect(older).toEqual(context)
		expect(older.map((m) => m.id)).toEqual(next.map((m) => m.id))
	} finally {
		await rec.release()
	}
})

it('a same-text copy of a recorded message is adopted and writes nothing; its later edit is one record', async () => {
	const { rec, session, context } = await recordedContext(4)
	try {
		const before = (await records(session.sessionLog)).length
		const next = [...context]
		const clone = structuredClone(next[3] as AssistantMessage)
		next[3] = clone
		rec.replaceMessages(next)
		await rec.flush()
		expect(counts(await records(session.sessionLog), before)).toEqual({})
		expect(rec.recordedIdOf(clone)).toBe((context[3] as AssistantMessage).id)

		// The clone is now the recorder's object for that message: editing it is one record.
		const edited = [...next]
		edited[3] = { ...clone, content: STUB }
		rec.replaceMessages(edited)
		await rec.flush()
		expect(counts(await records(session.sessionLog), before)).toEqual({ message_edited: 1 })
		expect(await folded(session)).toEqual(edited)
	} finally {
		await rec.release()
	}
})
