import { expect, it, vi } from 'vitest'
import { memorySession, records } from '../../../runtime/query/__tests__/support/session.js'
import { EventTranslator } from '../../../runtime/query/events.js'
import {
	type Message,
	createAssistantMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import { generateTurnId } from '../../../utils/id.js'
import { TurnRecorder } from '../turn-recorder.js'

/**
 * A re-base (`#recordCompaction`) fires whenever the live message array is no
 * longer "the recorded view plus an appended tail" — most commonly the
 * provider-rejected-image repair, which rebuilds ONE message in the MIDDLE as a
 * fresh object. The old fallback collapsed the WHOLE context into the
 * compaction record's `summary` and stripped every message's id, so the next
 * re-base was again "not ordered" and re-inlined an ever-larger context — a
 * session log that grew without bound and, once replayed, blew the heap.
 *
 * This drives that exact shape 20 times and asserts the log stays bounded and
 * the ids survive. It fails on the old code (summary grows ~linearly with the
 * number of passes; all ids stripped after pass 1) and passes once a re-base
 * keeps recorded messages by id and re-records only what moved.
 */
async function recorder() {
	const session = memorySession()
	const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }
	log.child.mockReturnValue(log)
	const rec = new TurnRecorder({
		...session,
		turnId: generateTurnId(),
		agentId: 'rebase-test',
		agentName: 'Rebase test',
		turnConfig: { model: 'mock', tokenBudget: 0, timeoutMs: 0 },
		providerId: 'mock',
		log,
	})
	await rec.open({ session: { cwd: '/tmp' } })
	await new EventTranslator(rec).beginTurn({})
	rec.markRunning()
	return { rec, session }
}

function summaryLength(record: { type: string; summary?: unknown }): number {
	if (record.type !== 'compaction') return 0
	return Array.isArray(record.summary) ? record.summary.length : 0
}

it('a middle-message repair repeated many times keeps the log bounded and ids intact', async () => {
	const { rec, session } = await recorder()
	try {
		// Eight recorded messages, each with its own record and id.
		const base: Message[] = [
			createUserMessage('start'),
			...Array.from({ length: 6 }, (_, i) => createAssistantMessage(`step ${i}`)),
			createUserMessage('go on'),
		]
		for (const message of base) rec.pushMessage(message)
		await rec.flush()
		expect(base[0]?.id).toBeTypeOf('string')

		// Simulate the image-repair re-base 20 times: rebuild the SAME middle
		// slot as a brand-new object (no recorded identity) in place.
		let current = [...base]
		const passes = 20
		for (let pass = 0; pass < passes; pass++) {
			const repaired = { ...createAssistantMessage(`repaired ${pass}`) }
			current = [...current]
			current[3] = repaired
			rec.replaceMessages(current)
			await rec.flush()
		}

		const all = await records(session.sessionLog)
		const compactions = all.filter((r) => r.type === 'compaction')
		const totalSummaryMessages = compactions.reduce((n, r) => n + summaryLength(r), 0)

		// The bug copied the whole (growing) context into `summary` on every pass,
		// so this total grew ~linearly with `passes` into the hundreds. Bounded now.
		expect(totalSummaryMessages).toBeLessThan(current.length * 2)

		// No single re-base record carries more than a small constant.
		for (const c of compactions) expect(summaryLength(c)).toBeLessThanOrEqual(current.length)

		// The whole file must not scale with the number of passes. Compare the
		// serialized size against a generous per-message bound.
		const serialized = all.reduce((n, r) => n + JSON.stringify(r).length, 0)
		expect(serialized).toBeLessThan(current.length * 4000 + passes * 4000)

		// The recorded messages were never globally stripped of their ids.
		expect(base[0]?.id).toBeTypeOf('string')
		expect(current[0]?.id).toBeTypeOf('string')
	} finally {
		await rec.release()
	}
})
