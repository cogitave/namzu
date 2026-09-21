import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ids } from '../../../__fixtures__/session-log/build.js'
import type { SessionId } from '../../../types/ids/index.js'
import { SessionLogIntegrityError, readSessionLogTail } from '../chain.js'
import { walkSessionLog } from '../core.js'
import { readSessionLog } from '../disk.js'
import { InMemoryLogMedium } from '../memory.js'

const FIXTURES = join(import.meta.dirname, '../../../__fixtures__/session-log')
const fixture = (name: string) => join(FIXTURES, name)

function medium(bytes: Uint8Array | string): InMemoryLogMedium {
	const m = new InMemoryLogMedium()
	m.overwrite(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
	return m
}

async function readBytes(bytes: Uint8Array | string, options = {}) {
	const entries = []
	const walk = walkSessionLog(medium(bytes), options)
	for (;;) {
		const step = await walk.next()
		if (step.done) return { ...step.value, entries }
		entries.push(step.value)
	}
}

/** Rewrite a log's records and re-chain every `prev`, as a forger with the whole file would. */
function rechain(text: string, edit: (record: Record<string, unknown>) => void): string {
	let offset = 0
	let prev: unknown = null
	const out: string[] = []
	for (const raw of text.split('\n').filter((line) => line.length > 0)) {
		const record = JSON.parse(raw) as Record<string, unknown>
		edit(record)
		record.prev = prev
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
	}
	return out.join('')
}

const INTACT = [
	'valid.jsonl',
	'repaired.jsonl',
	'compaction.jsonl',
	'paused-then-resumed.jsonl',
	'abandoned.jsonl',
	'guardrail-replaced.jsonl',
	'batch-annotated.jsonl',
	'origin-external-refs.jsonl',
]

describe('a session log is a hash chain', () => {
	it.each(INTACT)('reads %s strictly, every prev naming the bytes before it', async (name) => {
		const read = await readSessionLog(fixture(name))
		expect(read.intact).toBe(true)
		expect(read.tornBytes).toBe(0)
		expect(read.entries[0]?.record.type).toBe('session_started')
		const size = readFileSync(fixture(name)).byteLength
		expect(read.head?.bytes).toBe(size)
		for (let i = 1; i < read.entries.length; i++) {
			expect(read.entries[i]?.record.prev).toEqual(read.entries[i - 1]?.pointer)
		}
	})

	it('reads both logs of a parent and its child session', async () => {
		const parent = ids.session('parent') as SessionId
		const child = ids.session('child') as SessionId
		const dir = fixture('child-sessions')
		expect(readdirSync(dir)).toContain(`${parent}.jsonl`)
		const parentRead = await readSessionLog(join(dir, `${parent}.jsonl`), { sessionId: parent })
		const childRead = await readSessionLog(join(dir, parent, 'subagents', `${child}.jsonl`), {
			sessionId: child,
		})
		expect(parentRead.intact && childRead.intact).toBe(true)
	})

	it('refuses the broken chain strictly and stops before the break tolerantly', async () => {
		const error = await readSessionLog(fixture('broken-chain.jsonl')).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(SessionLogIntegrityError)
		expect((error as SessionLogIntegrityError).reason).toBe('prev-mismatch')
		expect((error as SessionLogIntegrityError).seq).toBe(4)
		const tolerant = await readSessionLog(fixture('broken-chain.jsonl'), { mode: 'tolerant' })
		expect(tolerant.intact).toBe(false)
		expect(tolerant.throughSeq).toBe(3)
		expect(tolerant.entries).toHaveLength(3)
		expect(tolerant.break?.reason).toBe('prev-mismatch')
	})

	it('reports a torn tail without treating it as a break', async () => {
		const read = await readSessionLog(fixture('torn-tail.jsonl'))
		expect(read.intact).toBe(true)
		expect(read.tornBytes).toBe(40)
		expect(read.head?.bytes).toBe(readFileSync(fixture('torn-tail.jsonl')).byteLength - 40)
	})

	it('refuses a flipped byte in any record but the last', async () => {
		const bytes = readFileSync(fixture('valid.jsonl'))
		const read = await readSessionLog(fixture('valid.jsonl'))
		const target = read.entries[5]?.pointer
		if (target === undefined) throw new Error('fixture too short')
		const text = bytes.subarray(target.offset, target.offset + target.length).toString('utf8')
		// A byte inside a string value, so the line still parses and only the chain can tell.
		const at = target.offset + Buffer.byteLength(text.slice(0, text.indexOf('"ts":"') + 8))
		const flipped = Buffer.from(bytes)
		flipped[at] = flipped[at] === 0x31 ? 0x32 : 0x31
		const error = await readBytes(flipped).catch((e: unknown) => e)
		expect((error as SessionLogIntegrityError).reason).toBe('prev-mismatch')
		expect((error as SessionLogIntegrityError).seq).toBe(7)
	})

	it('anchors the tail: a log that does not hold the expected head is refused', async () => {
		const text = readFileSync(fixture('valid.jsonl'), 'utf8')
		const read = await readSessionLog(fixture('valid.jsonl'))
		const head = read.head?.pointer
		if (head === undefined) throw new Error('empty fixture')
		expect((await readBytes(text, { expectHead: head })).intact).toBe(true)
		// Truncated at a line boundary: a valid chain, one record short.
		const truncated = text.slice(0, head.offset)
		expect((await readBytes(truncated)).intact).toBe(true)
		const error = await readBytes(truncated, { expectHead: head }).catch((e: unknown) => e)
		expect((error as SessionLogIntegrityError).reason).toBe('anchor-mismatch')
		const tolerant = await readBytes(truncated, { expectHead: head, mode: 'tolerant' })
		expect(tolerant.intact).toBe(false)
	})

	it('resumes after a cursor, checking the cursor first', async () => {
		const text = readFileSync(fixture('valid.jsonl'), 'utf8')
		const all = await readSessionLog(fixture('valid.jsonl'))
		const cursor = all.entries[9]?.pointer
		if (cursor === undefined) throw new Error('fixture too short')
		const rest = await readBytes(text, { after: cursor })
		expect(rest.entries.map((e) => e.record.seq)).toEqual(
			all.entries.slice(10).map((e) => e.record.seq),
		)
		const forged = { ...cursor, sha256: '0'.repeat(64) }
		const error = await readBytes(text, { after: forged }).catch((e: unknown) => e)
		expect((error as SessionLogIntegrityError).reason).toBe('anchor-mismatch')
	})

	it('stops at throughSeq', async () => {
		const read = await readSessionLog(fixture('valid.jsonl'), { throughSeq: 4 })
		expect(read.entries.map((e) => e.record.seq)).toEqual([1, 2, 3, 4])
		expect(read.throughSeq).toBe(4)
	})

	it('refuses a gen that goes backwards, even when the chain is re-hashed', async () => {
		const text = rechain(readFileSync(fixture('valid.jsonl'), 'utf8'), (record) => {
			if ((record.seq as number) <= 5) record.gen = 2
		})
		const error = await readBytes(text).catch((e: unknown) => e)
		expect((error as SessionLogIntegrityError).reason).toBe('gen-regressed')
		expect((error as SessionLogIntegrityError).seq).toBe(6)
	})

	it('refuses a record from another session, even when the chain is re-hashed', async () => {
		const text = rechain(readFileSync(fixture('valid.jsonl'), 'utf8'), (record) => {
			if (record.seq === 3) record.sessionId = ids.session('someone-else')
		})
		const error = await readBytes(text).catch((e: unknown) => e)
		expect((error as SessionLogIntegrityError).reason).toBe('session-mismatch')
	})

	it('refuses a log that does not start with session_started', async () => {
		const text = readFileSync(fixture('valid.jsonl'), 'utf8')
		const withoutStart = text.slice(text.indexOf('\n') + 1)
		const error = await readBytes(withoutStart).catch((e: unknown) => e)
		expect((error as SessionLogIntegrityError).reason).toBe('bad-start')
	})

	it('refuses a text skip link that points forward', async () => {
		const text = rechain(readFileSync(fixture('valid.jsonl'), 'utf8'), () => {})
		const lines = text.split('\n')
		const third = JSON.parse(lines[2] as string) as Record<string, unknown>
		const prev = third.prev as { seq: number; offset: number; length: number; sha256: string }
		// A skip link naming the same seq as prev with a different hash.
		const forged = rechain(text, (record) => {
			if (record.seq === 3) record.prevText = { ...prev, sha256: 'f'.repeat(64) }
		})
		const error = await readBytes(forged).catch((e: unknown) => e)
		expect((error as SessionLogIntegrityError).reason).toBe('bad-text-link')
		// A skip link equal to prev is accepted.
		const honest = rechain(text, (record) => {
			if (record.seq === 3) record.prevText = prev
		})
		expect((await readBytes(honest)).intact).toBe(true)
	})

	it('bootstraps the head from the tail alone', async () => {
		const bytes = readFileSync(fixture('valid.jsonl'))
		const read = await readSessionLog(fixture('valid.jsonl'))
		const tail = await readSessionLogTail(medium(bytes))
		expect(tail?.entry.pointer).toEqual(read.head?.pointer)
		expect(await readSessionLogTail(medium(readFileSync(fixture('torn-tail.jsonl'))))).toBe(
			undefined,
		)
		expect(await readSessionLogTail(medium(''))).toBe(undefined)
	})

	it('treats a missing file as an empty log', async () => {
		const read = await readSessionLog(join(FIXTURES, 'no-such-log.jsonl'))
		expect(read).toMatchObject({ intact: true, throughSeq: 0, head: null, entries: [] })
	})
})
