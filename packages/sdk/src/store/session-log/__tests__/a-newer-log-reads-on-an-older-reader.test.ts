import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { SessionRecord } from '../../../types/session/records.js'
import { readIndexableRecords } from '../../session-index/rebuild.js'
import { externalRefChanges } from '../../session-index/refs.js'
import { SessionLogIntegrityError } from '../chain.js'
import { walkSessionLog } from '../core.js'
import { foldSessionMessages } from '../fold.js'
import { InMemoryLogMedium } from '../memory.js'

const VALID = readFileSync(
	join(import.meta.dirname, '../../../__fixtures__/session-log/valid.jsonl'),
	'utf8',
)

type Insert = readonly [afterSeq: number, extra: Record<string, unknown>]

/**
 * The log a newer writer would produce: each extra record is inserted after
 * the original record `afterSeq`, later records are renumbered and the whole
 * chain is re-linked, as a writer appending in that order would have linked it.
 * `rename` is how an older reader sees the same bytes: the types it does not
 * know under another name, relinked like the rest.
 */
function newerLogWith(inserts: readonly Insert[], rename?: (type: string) => string): string {
	const records = VALID.split('\n')
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
	const base = records[0] as Record<string, unknown>
	for (const [afterSeq, extra] of [...inserts].sort((x, y) => y[0] - x[0])) {
		records.splice(afterSeq, 0, {
			v: base.v,
			id: randomUUID(),
			sessionId: base.sessionId,
			gen: base.gen,
			ts: base.ts,
			...extra,
		})
	}
	if (rename) for (const record of records) record.type = rename(record.type as string)
	let offset = 0
	let prev: unknown = null
	const out: string[] = []
	records.forEach((record, index) => {
		record.seq = index + 1
		record.prev = prev
		if (Object.hasOwn(record, 'prevText')) record.prevText = prev
		const line = `${JSON.stringify(record)}\n`
		const length = Buffer.byteLength(line)
		prev = {
			seq: record.seq,
			offset,
			length,
			sha256: createHash('sha256').update(line).digest('hex'),
		}
		offset += length
		out.push(line)
	})
	return out.join('')
}

function newerLog(afterSeq: number, extra: Record<string, unknown>): string {
	return newerLogWith([[afterSeq, extra]])
}

async function read(text: string) {
	const medium = new InMemoryLogMedium()
	medium.overwrite(Buffer.from(text, 'utf8'))
	const records: SessionRecord[] = []
	const walk = walkSessionLog(medium, {})
	for (;;) {
		const step = await walk.next()
		if (step.done) return { summary: step.value, records }
		records.push(step.value.record)
	}
}

const FUTURE = {
	type: 'future_annotation',
	note: 'written by a newer release',
	extra: { n: 1 },
}

describe('a newer log read by the current reader', () => {
	it('keeps a flagged unknown record in the chain and leaves the fold untouched', async () => {
		const plain = await read(VALID)
		const newer = await read(newerLog(3, { ...FUTURE, ignorable: true }))
		expect(newer.summary.intact).toBe(true)
		expect(newer.records).toHaveLength(plain.records.length + 1)
		expect(newer.records[3]?.type).toBe('future_annotation')
		// The records after it still verify against it, so the chain covers it.
		expect(newer.records[4]?.prev?.seq).toBe(4)
		const folded = await foldSessionMessages(newer.records)
		const baseline = await foldSessionMessages(plain.records)
		expect(folded).toEqual(baseline)
	})

	it('lets the other readers pass a flagged record without acting on it', async () => {
		const text = newerLog(3, { ...FUTURE, ignorable: true })
		const path = join(mkdtempSync(join(tmpdir(), 'newer-log-')), 'log.jsonl')
		writeFileSync(path, text)
		const types: string[] = []
		for await (const entry of readIndexableRecords(path)) types.push(entry.record.type)
		expect(types).toHaveLength(text.split('\n').filter((l) => l.length > 0).length)
		expect(types[3]).toBe('future_annotation')
		const { records } = await read(text)
		expect(externalRefChanges(records[3] as SessionRecord)).toEqual([])
	})

	it('passes a flagged record that carries a turn id, in the middle of an open turn', async () => {
		const turnId = '2efe5139-799c-4a05-821e-285dbc1eb45f'
		const plain = await read(VALID)
		// After seq 5 (tool_executing), before its tool_completed.
		const newer = await read(newerLog(5, { ...FUTURE, turnId, ignorable: true }))
		expect(newer.summary.intact).toBe(true)
		expect(newer.records[5]?.type).toBe('future_annotation')
		expect(await foldSessionMessages(newer.records)).toEqual(
			await foldSessionMessages(plain.records),
		)
	})

	it('passes a flagged record after a turn has completed, and at the end of the log', async () => {
		const plain = await read(VALID)
		const baseline = await foldSessionMessages(plain.records)
		const afterTurn = await read(newerLog(15, { ...FUTURE, ignorable: true }))
		expect(afterTurn.summary.intact).toBe(true)
		expect(await foldSessionMessages(afterTurn.records)).toEqual(baseline)
		const atEnd = await read(newerLog(25, { ...FUTURE, ignorable: true }))
		expect(atEnd.summary.intact).toBe(true)
		expect(atEnd.records.at(-1)?.type).toBe('future_annotation')
		expect(await foldSessionMessages(atEnd.records)).toEqual(baseline)
	})

	it('refuses the same record when it is not flagged ignorable', async () => {
		const error = await read(newerLog(3, FUTURE)).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(SessionLogIntegrityError)
		expect((error as SessionLogIntegrityError).reason).toBe('not-a-record')
		expect((error as SessionLogIntegrityError).seq).toBe(4)
	})

	it('still verifies a flagged record: altering it breaks the next link', async () => {
		const text = newerLog(3, { ...FUTURE, ignorable: true })
		const tampered = text.replace('written by a newer release', 'written by someone else!!')
		const error = await read(tampered).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(SessionLogIntegrityError)
		expect((error as SessionLogIntegrityError).reason).toBe('prev-mismatch')
	})

	it('does not let the flag excuse a known type with a bad payload', async () => {
		const error = await read(newerLog(3, { type: 'message', ignorable: true })).catch(
			(e: unknown) => e,
		)
		expect(error).toBeInstanceOf(SessionLogIntegrityError)
		expect((error as SessionLogIntegrityError).reason).toBe('not-a-record')
	})

	it('does not let a flagged record start a log', async () => {
		const first = JSON.parse(VALID.split('\n')[0] as string) as Record<string, unknown>
		const line = `${JSON.stringify({ ...first, type: 'future_annotation', ignorable: true })}\n`
		const error = await read(line).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(SessionLogIntegrityError)
	})
})

describe('the turn outcome records on a log read by an older release', () => {
	const TURN = '2efe5139-799c-4a05-821e-285dbc1eb45f'
	const OUTCOME = {
		verdict: 'unchecked',
		basis: 'calls',
		changes: { total: 1, paths: ['a.ts'], outsideKnownTools: false },
		checks: [],
	}
	// Where a real writer puts them: the progress just before a checkpoint
	// record, the turn's outcome just before its end record, a child's just
	// before `child_session_ended`.
	const INSERTS: readonly Insert[] = [
		[
			13,
			{
				type: 'outcome_progress_written',
				ignorable: true,
				turnId: TURN,
				checkpointId: 'b1f0a9c2-3d4e-4f5a-8b6c-7d8e9f0a1b2c',
				progress: { v: 1 },
			},
		],
		[14, { type: 'turn_outcome_recorded', ignorable: true, turnId: TURN, outcome: OUTCOME }],
		[
			15,
			{
				type: 'child_outcome_recorded',
				ignorable: true,
				childSessionId: 'c2a1b0d3-4e5f-4a6b-9c7d-8e9f0a1b2c3d',
				outcome: OUTCOME,
			},
		],
	]
	const NEW_TYPES = ['outcome_progress_written', 'turn_outcome_recorded', 'child_outcome_recorded']

	it('are read by the current release, in the chain, and leave the fold alone', async () => {
		const plain = await read(VALID)
		const newer = await read(newerLogWith(INSERTS))
		expect(newer.summary.intact).toBe(true)
		expect(newer.records).toHaveLength(plain.records.length + 3)
		expect(newer.records.filter((r) => NEW_TYPES.includes(r.type))).toHaveLength(3)
		expect(await foldSessionMessages(newer.records)).toEqual(
			await foldSessionMessages(plain.records),
		)
	})

	it('are skipped by a release that has never heard of them, which loses only the outcome', async () => {
		const plain = await read(VALID)
		const baseline = await foldSessionMessages(plain.records)
		const olderView = (type: string) => (NEW_TYPES.includes(type) ? `future_${type}` : type)
		const text = newerLogWith(INSERTS, olderView)
		const older = await read(text)
		expect(older.summary.intact).toBe(true)
		expect(older.records).toHaveLength(plain.records.length + 3)
		// The records around them are the ones the plain log has, in order.
		expect(older.records.map((r) => r.type).filter((type) => !type.startsWith('future_'))).toEqual(
			plain.records.map((r) => r.type),
		)
		expect(await foldSessionMessages(older.records)).toEqual(baseline)
		// The index rebuild walks the same bytes and passes them too.
		const path = join(mkdtempSync(join(tmpdir(), 'newer-log-')), 'log.jsonl')
		writeFileSync(path, text)
		const types: string[] = []
		for await (const entry of readIndexableRecords(path)) types.push(entry.record.type)
		expect(types).toHaveLength(plain.records.length + 3)
		expect(types.filter((type) => type.startsWith('future_'))).toHaveLength(3)
	})

	it('are read by the current release by the index rebuild too', async () => {
		const text = newerLogWith(INSERTS)
		const path = join(mkdtempSync(join(tmpdir(), 'newer-log-')), 'log.jsonl')
		writeFileSync(path, text)
		const types: string[] = []
		for await (const entry of readIndexableRecords(path)) types.push(entry.record.type)
		expect(types.filter((type) => NEW_TYPES.includes(type))).toHaveLength(3)
	})

	it('are refused when they are not flagged ignorable, so an older release would refuse them', async () => {
		const [, extra] = INSERTS[1] as Insert
		const { ignorable: _flag, ...unflagged } = extra
		const error = await read(newerLog(14, unflagged)).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(SessionLogIntegrityError)
	})
})
