import { expect, it, vi } from 'vitest'
import { memorySession, records } from '../../../runtime/query/__tests__/support/session.js'
import { EventTranslator } from '../../../runtime/query/events.js'
import { foldSessionMessages } from '../../../store/session-log/fold.js'
import type { MessageId, TurnId } from '../../../types/ids/index.js'
import {
	type Message,
	createAssistantMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import { generateCheckpointId, generateTurnId } from '../../../utils/id.js'
import { TurnRecorder } from '../turn-recorder.js'

/**
 * A resume restores a context in which some messages have no id (a compaction
 * summary, the working-memory slot, a message a host added) and may arrive
 * before the recorded ones. The recorder holds them until the whole context is
 * in place and re-bases once; after every step the fold equals the live
 * context and no message is recorded twice. Every check is a comparison of
 * what the log folds to with the live context, or a count of records.
 */

type Session = ReturnType<typeof memorySession>

function recorderFor(session: Session, turnId: TurnId) {
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

const WM = (): Message =>
	({ role: 'system', content: '[WORKING MEMORY] artifacts', timestamp: 3 }) as Message
const SUM = (): Message =>
	({
		role: 'system',
		content: 'Summary of the earlier work.',
		source: { type: 'compaction-summary' },
		timestamp: 2,
	}) as Message

async function firstProcess(texts: readonly string[]) {
	const session = memorySession()
	const turnId = generateTurnId()
	const rec = recorderFor(session, turnId)
	await rec.open({ session: { cwd: '/tmp' } })
	await new EventTranslator(rec).beginTurn({})
	rec.markRunning()
	const context: Message[] = texts.map((t, i) =>
		i === 0 ? createUserMessage(t) : createAssistantMessage(t),
	)
	for (const m of context) rec.pushMessage(m)
	await rec.flush()
	return { session, turnId, rec, context }
}

const text = (messages: readonly Message[]) => messages.map((m) => String(m.content))
const foldNow = async (session: Session) =>
	foldSessionMessages((await session.sessionLog.readAll()).entries.map((e) => e.record))

/** Fold equals live, and no message text is recorded as a `message` more than once. */
async function expectFoldIsLive(session: Session, live: readonly Message[]) {
	expect(text(await foldNow(session))).toEqual(text(live))
	const counts = new Map<string, number>()
	for (const r of await records(session.sessionLog))
		if (r.type === 'message') {
			const key = String(r.content.content)
			counts.set(key, (counts.get(key) ?? 0) + 1)
		}
	expect([...counts.values()].filter((n) => n > 1)).toEqual([])
}

/** A new process on the same log; the folded context is pushed back as the restored history. */
async function resumeFromFold(session: Session, turnId: TurnId) {
	const rec = recorderFor(session, turnId)
	await rec.open({ session: { cwd: '/tmp' } })
	await rec.resume(generateCheckpointId())
	const live = await foldNow(session)
	const restored = live.map((m) => ({ ...m }))
	for (const m of restored)
		rec.pushMessage(m, { ...(m.id ? { messageId: m.id as MessageId } : {}), restored: true })
	return { rec, live: restored }
}

const q = () => createUserMessage('q')

const shapes: [string, (c: Message[]) => Message[], string[]][] = [
	['a working-memory slot ahead of every recorded message', (c) => [WM(), ...c], ['go', 'a', 'b']],
	[
		'a working-memory slot and a summary, then recorded messages',
		(c) => [WM(), SUM(), ...c.slice(-3)],
		['go', 'a', 'b', 'c', 'd'],
	],
	[
		'a summary and a working-memory slot, then recorded messages',
		(c) => [SUM(), WM(), ...c.slice(-3)],
		['go', 'a', 'b', 'c', 'd'],
	],
	[
		'an id-less user message between the summary and the recorded ones',
		(c) => [SUM(), createUserMessage('inj'), ...c.slice(-3)],
		['go', 'a', 'b', 'c', 'd'],
	],
]

for (const [name, shape, texts] of shapes) {
	it(`keeps the recorded messages after ${name}, through a resume and a second resume`, async () => {
		const { session, turnId, rec, context } = await firstProcess(texts)
		rec.replaceMessages(shape(context))
		await rec.flush()
		await rec.release()
		await expectFoldIsLive(session, await foldNow(session))

		let { rec: resumed, live } = await resumeFromFold(session, turnId)
		const next = q()
		live.push(next)
		resumed.pushMessage(next)
		await resumed.flush()
		await expectFoldIsLive(session, live)
		await resumed.release()

		// Resume twice in a row: the second restores what the first left.
		const second = await resumeFromFold(session, turnId)
		resumed = second.rec
		live = second.live
		const again = createAssistantMessage('again')
		live.push(again)
		resumed.pushMessage(again)
		await resumed.flush()
		await expectFoldIsLive(session, live)
		await resumed.release()
	})
}

it('reconciles a held context when the turn pauses right after the restore', async () => {
	const { session, turnId, rec, context } = await firstProcess(['go', 'a', 'b'])
	rec.replaceMessages([WM(), ...context])
	await rec.flush()
	await rec.release()
	const before = (await records(session.sessionLog)).length
	const { rec: resumed, live } = await resumeFromFold(session, turnId)
	// Nothing is written while the context is held.
	await resumed.flush()
	expect((await records(session.sessionLog)).length).toBe(before + 1) // turn_resuming only
	await resumed.appendEvent({
		type: 'turn_paused',
		turnId,
		reason: 'test',
		checkpointId: generateCheckpointId(),
	} as never)
	await resumed.flush()
	await expectFoldIsLive(session, live)
	await resumed.release()
})

it('puts back an edit the restored context predates, when the fold also holds a summary', async () => {
	const { session, turnId, rec, context } = await firstProcess(['go', 'a', 'b', 'c', 'd'])
	const live: Message[] = [SUM(), ...context.slice(-3)]
	rec.replaceMessages(live)
	rec.replaceMessages([
		live[0] as Message,
		{ ...(live[1] as Message), content: 'b-EDITED' } as Message,
		...live.slice(2),
	])
	await rec.flush()
	await rec.release()
	expect(text(await foldNow(session))).toEqual([
		'Summary of the earlier work.',
		'b-EDITED',
		'c',
		'd',
	])

	const resumed = recorderFor(session, turnId)
	await resumed.open({ session: { cwd: '/tmp' } })
	await resumed.resume(generateCheckpointId())
	const restored = (await foldNow(session)).map((m) => ({ ...m }))
	restored[1] = { ...(restored[1] as Message), content: 'b' } as Message
	for (const m of restored)
		resumed.pushMessage(m, { ...(m.id ? { messageId: m.id as MessageId } : {}), restored: true })
	const next = q()
	restored.push(next)
	resumed.pushMessage(next)
	await resumed.flush()
	await expectFoldIsLive(session, restored)
	// One message_edited puts the context's text back; nothing is recorded again.
	const all = await records(session.sessionLog)
	expect(all.filter((r) => r.type === 'message_edited')).toHaveLength(2)
	await resumed.release()
})
