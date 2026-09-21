import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ids } from '../../../__fixtures__/session-log/build.js'
import type { MessageId, TurnId } from '../../../types/ids/index.js'
import type { SessionRecord } from '../../../types/session/records.js'
import { readSessionLog } from '../disk.js'
import {
	SessionMessageFold,
	SessionTurnState,
	SpillUnavailableError,
	TurnRuleError,
	foldSessionMessages,
} from '../fold.js'

const FIXTURES = join(import.meta.dirname, '../../../__fixtures__/session-log')

async function records(name: string): Promise<SessionRecord[]> {
	return (await readSessionLog(join(FIXTURES, name))).entries.map((e) => e.record)
}

describe('the message fold', () => {
	it('shows the guardrail rewrite, never the raw answer', async () => {
		const messages = await foldSessionMessages(await records('guardrail-replaced.jsonl'))
		expect(messages).toEqual([
			{ role: 'user', content: 'What is the admin password?' },
			{ role: 'assistant', content: 'I cannot share credentials.' },
		])
	})

	it('replaces the compacted range with the summary and keeps what the compaction kept', async () => {
		const log = await records('compaction.jsonl')
		const firstCompaction = log.find((r) => r.type === 'compaction')
		if (firstCompaction === undefined) throw new Error('fixture has no compaction')
		expect(await foldSessionMessages(log, { throughSeq: firstCompaction.seq })).toEqual([
			{
				role: 'system',
				content: 'The user asked for a summary.',
				source: { type: 'compaction-summary' },
			},
			{ role: 'assistant', content: 'It is a TypeScript monorepo.' },
		])
		// The manual compaction between turns replaces everything and keeps nothing.
		expect(await foldSessionMessages(log)).toEqual([
			{
				role: 'system',
				content: 'Earlier: a repository summary.',
				source: { type: 'compaction-summary' },
			},
		])
	})

	it('keeps every message after the compacted range, and messages appended later', () => {
		const fold = new SessionMessageFold()
		const m = (seq: number, id: string, content: string) =>
			({
				type: 'message',
				seq,
				messageId: id as MessageId,
				role: 'user',
				content: { role: 'user', content },
			}) as unknown as SessionRecord
		fold.apply(m(2, 'a', 'one'))
		fold.apply(m(3, 'b', 'two'))
		fold.apply(m(4, 'c', 'three'))
		fold.apply({
			type: 'compaction',
			seq: 5,
			replacesSeqRange: [2, 3],
			summary: [{ role: 'system', content: 'S' }],
			keptMessageIds: [],
		} as unknown as SessionRecord)
		fold.apply(m(6, 'd', 'four'))
		expect(fold.messages().map((x) => x.content)).toEqual(['S', 'three', 'four'])
		expect(fold.entries().map((e) => e.messageId)).toEqual([undefined, 'c', 'd'])
	})

	it('applies a replacement to a message that appears after it', () => {
		const fold = new SessionMessageFold()
		fold.apply({
			type: 'message_replaced',
			seq: 2,
			targetMessageId: 'x' as MessageId,
			content: { role: 'assistant', content: 'redacted' },
		} as unknown as SessionRecord)
		fold.apply({
			type: 'message',
			seq: 3,
			messageId: 'x' as MessageId,
			role: 'assistant',
			content: { role: 'assistant', content: 'raw' },
		} as unknown as SessionRecord)
		expect(fold.entries()).toEqual([
			{
				messageId: 'x',
				seq: 3,
				message: { role: 'assistant', content: 'redacted' },
				replacedAtSeq: 2,
			},
		])
	})

	it('keeps a replacement when its message is recorded again afterwards', () => {
		const fold = new SessionMessageFold()
		const raw = (seq: number) =>
			({
				type: 'message',
				seq,
				messageId: 'x' as MessageId,
				role: 'assistant',
				content: { role: 'assistant', content: 'RAW SECRET' },
			}) as unknown as SessionRecord
		fold.apply(raw(2))
		fold.apply({
			type: 'message_replaced',
			seq: 3,
			targetMessageId: 'x' as MessageId,
			content: { role: 'assistant', content: 'REDACTED' },
		} as unknown as SessionRecord)
		fold.apply(raw(4))
		expect(fold.messages().map((m) => m.content)).toEqual(['REDACTED'])
		expect(fold.entries()[0]).toMatchObject({ seq: 4, replacedAtSeq: 3 })
		// Nor after a compaction dropped it and the message came back.
		fold.apply({
			type: 'compaction',
			seq: 5,
			replacesSeqRange: [2, 4],
			summary: [],
			keptMessageIds: [],
		} as unknown as SessionRecord)
		fold.apply(raw(6))
		expect(fold.messages().map((m) => m.content)).toEqual(['REDACTED'])
	})

	it('refuses to fold spilled content without a way to read it', async () => {
		const spilled = {
			type: 'message',
			seq: 2,
			messageId: 'x' as MessageId,
			role: 'tool',
			content: { role: 'tool', content: 'preview', toolCallId: 't' },
			spill: {
				path: 'tool-results/a.txt',
				manifest: 'tool-results/a.txt.manifest.json',
				bytes: 1,
				sha256: 'a'.repeat(64),
			},
		} as unknown as SessionRecord
		await expect(foldSessionMessages([spilled])).rejects.toBeInstanceOf(SpillUnavailableError)
		expect(
			await foldSessionMessages([spilled], {
				readSpill: async () => JSON.stringify({ role: 'tool', content: 'full', toolCallId: 't' }),
			}),
		).toEqual([{ role: 'tool', content: 'full', toolCallId: 't' }])
	})
})

describe('the turn state', () => {
	it('tracks a paused turn until it resumes and completes', async () => {
		const log = await records('paused-then-resumed.jsonl')
		const state = new SessionTurnState()
		const turnId = ids.turn('paused-1')
		for (const record of log) {
			state.apply(record, { strict: true })
			if (record.type === 'turn_paused') {
				expect(state.active).toMatchObject({ turnId, paused: true })
			}
			if (record.type === 'turn_resuming') {
				expect(state.active).toMatchObject({ turnId, paused: false })
				expect(state.active?.pausedCheckpointId).toBe(undefined)
			}
		}
		expect(state.active).toBe(undefined)
		expect(state.lastTurnId).toBe(turnId)
	})

	it('accepts the abandoned and interrupted closures in the fixture', async () => {
		const state = new SessionTurnState()
		for (const record of await records('abandoned.jsonl')) state.apply(record, { strict: true })
		expect(state.active).toBe(undefined)
		expect(state.lastTurnId).toBe(ids.turn('abandoned-3'))
	})

	it('applies every fixture strictly', async () => {
		for (const name of [
			'valid.jsonl',
			'repaired.jsonl',
			'compaction.jsonl',
			'guardrail-replaced.jsonl',
			'batch-annotated.jsonl',
			'origin-external-refs.jsonl',
		]) {
			const state = new SessionTurnState()
			for (const record of await records(name)) state.apply(record, { strict: true })
		}
	})

	it('refuses what the turn rules forbid', () => {
		const t1 = 't1' as TurnId
		const t2 = 't2' as TurnId
		const state = new SessionTurnState()
		expect(() => state.check({ type: 'turn_started', turnId: t1 })).toThrow(TurnRuleError)
		state.apply({ type: 'session_started', seq: 1 } as unknown as SessionRecord)
		expect(() => state.check({ type: 'session_started', turnId: undefined })).toThrow(
			/only the first/,
		)
		expect(() => state.check({ type: 'message', turnId: t1 })).toThrow(/no turn is active/)
		state.apply({
			type: 'turn_started',
			turnId: t1,
			seq: 2,
			ts: 'x',
			gen: 1,
		} as unknown as SessionRecord)
		expect(() => state.check({ type: 'turn_started', turnId: t2 })).toThrow(/still active/)
		expect(() => state.check({ type: 'message', turnId: t2 })).toThrow(/active turn is t1/)
		state.apply({ type: 'turn_paused', turnId: t1, seq: 3 } as unknown as SessionRecord)
		expect(() => state.check({ type: 'message', turnId: t1 })).toThrow(/is paused/)
		expect(() => state.check({ type: 'turn_paused', turnId: t1 })).toThrow(TurnRuleError)
		expect(() => state.check({ type: 'decision_resolved', turnId: t1 })).not.toThrow()
		expect(() => state.check({ type: 'turn_resuming', turnId: t1 })).not.toThrow()
		// A record outside any turn may follow at any time.
		expect(() => state.check({ type: 'child_session_ended', turnId: undefined })).not.toThrow()
	})
})
