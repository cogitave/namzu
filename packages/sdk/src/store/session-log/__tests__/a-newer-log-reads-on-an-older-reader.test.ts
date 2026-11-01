import { createHash } from 'node:crypto'
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

/**
 * The log a newer writer would produce: `extra` is inserted after record
 * `afterSeq`, later records are renumbered and the whole chain is re-linked,
 * as a writer appending in that order would have linked it.
 */
function newerLog(afterSeq: number, extra: Record<string, unknown>): string {
	const records = VALID.split('\n')
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
	const base = records[0] as Record<string, unknown>
	const inserted = {
		v: base.v,
		id: '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f',
		sessionId: base.sessionId,
		gen: base.gen,
		ts: base.ts,
		...extra,
	}
	records.splice(afterSeq, 0, inserted)
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
