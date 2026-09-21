import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { buildSessionLogFixtures, ids } from '../../__fixtures__/session-log/build.js'
import {
	ChildSessionMetaSchema,
	PERSISTED_SESSION_EVENT_TYPES,
	SESSION_EVENT_TYPES,
	SESSION_RECORD_TYPES,
	type SessionRecord,
	SessionRecordSchema,
} from '../../types/session/records.js'
import {
	SessionLogLineError,
	formatSessionLogLine,
	parseSessionLogLine,
	recordSha256,
} from '../log-hash.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../__fixtures__/session-log')

function listFixtureFiles(dir: string = FIXTURES): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) return listFixtureFiles(path)
		return name.endsWith('.ts') ? [] : [relative(FIXTURES, path)]
	})
}

interface Line {
	readonly bytes: Buffer
	readonly offset: number
}

/** Split a log into lines, each with its newline; a last segment with none is returned as the tail. */
function splitLog(content: Buffer): { lines: Line[]; tail?: Buffer } {
	const lines: Line[] = []
	let offset = 0
	while (offset < content.byteLength) {
		const end = content.indexOf(0x0a, offset)
		if (end === -1) return { lines, tail: content.subarray(offset) }
		lines.push({ bytes: content.subarray(offset, end + 1), offset })
		offset = end + 1
	}
	return { lines }
}

/** The chain rule a strict reader applies; returns the seq of the first record whose `prev` is wrong. */
function firstChainBreak(lines: readonly Line[]): number | undefined {
	type Pointer = { seq: number; offset: number; length: number; sha256: string }
	let previous = null as Pointer | null
	for (const line of lines) {
		const { record } = parseSessionLogLine(line.bytes)
		const expectedSeq = previous === null ? 1 : previous.seq + 1
		if (JSON.stringify(record.prev) !== JSON.stringify(previous) || record.seq !== expectedSeq) {
			return record.seq
		}
		previous = {
			seq: record.seq,
			offset: line.offset,
			length: line.bytes.byteLength,
			sha256: recordSha256(line.bytes),
		}
	}
	return undefined
}

const logs = listFixtureFiles().filter((name) => name.endsWith('.jsonl'))

describe('session-log fixtures', () => {
	it('are exactly what the builder produces', () => {
		const built = buildSessionLogFixtures()
		expect(listFixtureFiles().sort()).toEqual(Object.keys(built).sort())
		for (const [name, content] of Object.entries(built)) {
			expect(readFileSync(join(FIXTURES, name), 'utf8'), name).toBe(content)
		}
	})

	it('cover every case the record schema names', () => {
		const seen = new Set<string>()
		for (const name of logs) {
			for (const line of splitLog(readFileSync(join(FIXTURES, name))).lines) {
				seen.add((JSON.parse(line.bytes.toString('utf8')) as { type: string }).type)
			}
		}
		for (const type of [
			'session_started',
			'session_updated',
			'turn_started',
			'turn_paused',
			'turn_resuming',
			'turn_completed',
			'turn_failed',
			'message',
			'message_replaced',
			'checkpoint_written',
			'decision_requested',
			'decision_resolved',
			'decision_expired',
			'compaction',
			'compaction_shed',
			'compaction_completed',
			'child_session_spawned',
			'child_session_messaged',
			'child_session_idled',
			'child_session_ended',
			'audit',
			'budget_bound',
			'log_repaired',
		]) {
			expect(seen, type).toContain(type)
		}
	})

	it.each(logs)('%s: every complete line round-trips through the schema', (name) => {
		const { lines } = splitLog(readFileSync(join(FIXTURES, name)))
		expect(lines.length).toBeGreaterThan(0)
		for (const line of lines) {
			const raw = JSON.parse(line.bytes.toString('utf8'))
			const parsed = parseSessionLogLine(line.bytes)
			expect(parsed.record).toEqual(raw)
			expect(parsed.length).toBe(line.bytes.byteLength)
			// Serialising the parsed record gives a line that parses to the same record.
			const again = parseSessionLogLine(formatSessionLogLine(parsed.record))
			expect(again.record).toEqual(parsed.record)
		}
	})

	it.each(logs.filter((name) => name !== 'broken-chain.jsonl'))(
		'%s: the hash chain is intact',
		(name) => {
			expect(firstChainBreak(splitLog(readFileSync(join(FIXTURES, name))).lines)).toBeUndefined()
		},
	)

	it('broken-chain: a strict reader finds the altered link at seq 4', () => {
		const { lines } = splitLog(readFileSync(join(FIXTURES, 'broken-chain.jsonl')))
		expect(firstChainBreak(lines)).toBe(4)
	})

	it('torn-tail: the last append has no newline and is refused as torn', () => {
		const { lines, tail } = splitLog(readFileSync(join(FIXTURES, 'torn-tail.jsonl')))
		expect(firstChainBreak(lines)).toBeUndefined()
		expect(tail).toBeDefined()
		expect(() => parseSessionLogLine(tail as Buffer)).toThrow(SessionLogLineError)
		try {
			parseSessionLogLine(tail as Buffer)
		} catch (error) {
			expect((error as SessionLogLineError).fault).toBe('torn')
		}
	})

	it('repaired: records the truncation after the last good record', () => {
		const { lines } = splitLog(readFileSync(join(FIXTURES, 'repaired.jsonl')))
		const last = parseSessionLogLine(lines.at(-1)?.bytes as Buffer).record
		expect(last).toMatchObject({ type: 'log_repaired', lastGoodSeq: lines.length - 1 })
	})

	it('paused-then-resumed: one turn id from start to end, the checkpoint pinned to a real record', () => {
		const records = readRecords('paused-then-resumed.jsonl')
		const turnIds = new Set(
			records.filter((r) => r.type !== 'session_started').map((r) => r.turnId),
		)
		expect([...turnIds]).toEqual([ids.turn('paused-1')])
		const written = records.find((r) => r.type === 'checkpoint_written') as Extract<
			SessionRecord,
			{ type: 'checkpoint_written' }
		>
		const lines = splitLog(readFileSync(join(FIXTURES, 'paused-then-resumed.jsonl'))).lines
		expect(recordSha256(lines[written.throughSeq - 1]?.bytes as Buffer)).toBe(written.throughSha256)
		const order = records.map((r) => r.type)
		expect(order.indexOf('turn_paused')).toBeLessThan(order.indexOf('turn_resuming'))
		expect(order.at(-1)).toBe('turn_completed')
	})

	it('abandoned: the failure codes the session log produces are abandoned and interrupted', () => {
		const failures = readRecords('abandoned.jsonl').filter((r) => r.type === 'turn_failed')
		expect(failures.map((r) => (r as { failure?: { code: string } }).failure?.code)).toEqual([
			'abandoned',
			'interrupted',
		])
	})

	it('guardrail-replaced: the replacement precedes the verdict and matches its result', () => {
		const records = readRecords('guardrail-replaced.jsonl')
		const replaced = records.findIndex((r) => r.type === 'message_replaced')
		const completed = records.findIndex((r) => r.type === 'turn_completed')
		expect(replaced).toBeGreaterThan(-1)
		expect(replaced).toBeLessThan(completed)
		const replacement = records[replaced] as Extract<SessionRecord, { type: 'message_replaced' }>
		const verdict = records[completed] as Extract<SessionRecord, { type: 'turn_completed' }>
		expect(replacement.content.content).toBe(verdict.result)
		expect(verdict.settlement.resultSource).toBe(replacement.reason)
		expect(
			records.some((r) => r.type === 'message' && r.messageId === replacement.targetMessageId),
		).toBe(true)
	})

	it('child-sessions: the child log and meta agree with the parent’s spawn record', () => {
		const parentName = logs.find((name) => /^child-sessions\/[^/]+\.jsonl$/.test(name)) as string
		const parent = readRecords(parentName)
		const spawned = parent.find((r) => r.type === 'child_session_spawned') as Extract<
			SessionRecord,
			{ type: 'child_session_spawned' }
		>
		const parentDir = parentName.replace(/\.jsonl$/, '')
		const child = readRecords(join(parentDir, spawned.path))
		const start = child[0] as Extract<SessionRecord, { type: 'session_started' }>
		expect(start.sessionId).toBe(spawned.childSessionId)
		expect(start.parent).toMatchObject({
			sessionId: parent[0]?.sessionId,
			turnId: spawned.turnId,
			toolCallId: spawned.toolCallId,
			depth: 1,
		})
		const meta = ChildSessionMetaSchema.parse(
			JSON.parse(
				readFileSync(
					join(FIXTURES, parentDir, 'subagents', `${spawned.childSessionId}.meta.json`),
					'utf8',
				),
			),
		)
		expect(meta.parentTurnId).toBe(spawned.turnId)
		const ended = parent.find((r) => r.type === 'child_session_ended')
		expect(ended).toMatchObject({ childSessionId: spawned.childSessionId, status: 'completed' })
	})

	it('batch-annotated: children carry the batch they were grouped in', () => {
		const batches = readRecords('batch-annotated.jsonl')
			.filter((r) => r.type === 'child_session_spawned')
			.map((r) => (r as Extract<SessionRecord, { type: 'child_session_spawned' }>).batch)
		expect(batches).toHaveLength(2)
		expect(new Set(batches.map((b) => b?.batchId)).size).toBe(1)
	})

	it('batch-annotated: a child that outlives its turn ends with no turnId, not a later one', () => {
		const records = readRecords('batch-annotated.jsonl')
		const ended = records.filter((r) => r.type === 'child_session_ended')
		expect(ended.map((r) => [r.childSessionId, r.turnId])).toEqual([
			[ids.session('batch-child-a'), ids.turn('batch-1')],
			[ids.session('batch-child-b'), undefined],
		])
		// The late end is written while batch-2 runs, and still does not name it.
		const late = records.indexOf(ended[1] as SessionRecord)
		const batch2 = records.findIndex(
			(r) => r.type === 'turn_started' && r.turnId === ids.turn('batch-2'),
		)
		expect(batch2).toBeGreaterThan(-1)
		expect(late).toBeGreaterThan(batch2)
		const first = records.find((r) => r.type === 'turn_completed') as Extract<
			SessionRecord,
			{ type: 'turn_completed' }
		>
		expect(first.settlement.abandonedTaskIds).toEqual(['toolu_fixture_batch_b'])
	})

	it.each(logs)('%s: no record names a turn that has already closed', (name) => {
		const closed = new Set<string>()
		for (const record of readRecords(name)) {
			if (record.turnId !== undefined) expect(closed, record.type).not.toContain(record.turnId)
			if (record.type === 'turn_completed' || record.type === 'turn_failed') {
				closed.add(record.turnId)
			}
		}
	})

	it('origin-external-refs: caller ids are kept verbatim, UUID or not', () => {
		const records = readRecords('origin-external-refs.jsonl')
		expect(records[0]).toMatchObject({
			origin: { protocol: 'ag-ui', externalSessionId: 'thread-7f' },
		})
		const turn = records.find((r) => r.type === 'turn_started')
		expect(turn).toMatchObject({ origin: { externalTurnId: 'run-client-1' } })
		const added = records.find((r) => r.type === 'session_updated')
		expect(added).toMatchObject({
			externalRefs: {
				add: expect.arrayContaining([expect.objectContaining({ externalId: 'ctx not a uuid' })]),
			},
		})
	})
})

describe('the session event and record type lists', () => {
	it('has 62 live event literals, 58 of them recorded', () => {
		expect(SESSION_EVENT_TYPES).toHaveLength(62)
		expect(new Set(SESSION_EVENT_TYPES).size).toBe(62)
		expect(PERSISTED_SESSION_EVENT_TYPES).toHaveLength(58)
		for (const ephemeral of [
			'text_delta',
			'tool_input_delta',
			'reasoning_delta',
			'tool_progress',
		]) {
			expect(SESSION_EVENT_TYPES).toContain(ephemeral)
			expect(PERSISTED_SESSION_EVENT_TYPES).not.toContain(ephemeral)
		}
	})

	it.each([
		['turn_started', 'turn_started'],
		['turn_completed', 'turn_completed'],
		['turn_failed', 'turn_failed'],
		['turn_paused', 'turn_paused'],
		['turn_resuming', 'turn_resuming'],
		['child_session_spawned', 'child_session_spawned'],
		['child_session_messaged', 'child_session_messaged'],
		['child_session_idled', 'child_session_idled'],
	])('renames %s to %s', (old, renamed) => {
		expect(SESSION_EVENT_TYPES).toContain(renamed)
		expect(SESSION_EVENT_TYPES).not.toContain(old)
		expect(SESSION_RECORD_TYPES).not.toContain(old)
	})

	it('keeps the three compaction events beside the record-only compaction type', () => {
		for (const type of [
			'compaction_completed',
			'compaction_shed',
			'compaction_tool_results_cleared',
		]) {
			expect(PERSISTED_SESSION_EVENT_TYPES).toContain(type)
		}
		expect(SESSION_EVENT_TYPES).not.toContain('compaction')
		expect(SESSION_RECORD_TYPES).toContain('compaction')
	})
})

describe('the record schema refuses', () => {
	const valid = () =>
		JSON.parse(
			splitLog(readFileSync(join(FIXTURES, 'valid.jsonl'))).lines[3]?.bytes.toString(
				'utf8',
			) as string,
		)

	it('accepts the baseline it mutates', () => {
		expect(SessionRecordSchema.safeParse(valid()).success).toBe(true)
	})

	it.each([
		['another schema version', (r: Record<string, unknown>) => ({ ...r, v: 2 })],
		['a run id', (r: Record<string, unknown>) => ({ ...r, runId: ids.turn('x') })],
		['lineage on a record', (r: Record<string, unknown>) => ({ ...r, lineage: { depth: 1 } })],
		[
			'a turn-bound event outside a turn',
			(r: Record<string, unknown>) => {
				const { turnId: _dropped, ...rest } = r
				return rest
			},
		],
		['a missing prev after seq 1', (r: Record<string, unknown>) => ({ ...r, prev: null })],
		['an unknown type', (r: Record<string, unknown>) => ({ ...r, type: 'turn_started' })],
		['a prefixed session id', (r: Record<string, unknown>) => ({ ...r, sessionId: 'ses_old' })],
		[
			'a local timestamp',
			(r: Record<string, unknown>) => ({ ...r, ts: '2026-09-21T09:00:00+02:00' }),
		],
	])('%s', (_name, mutate) => {
		expect(SessionRecordSchema.safeParse(mutate(valid())).success).toBe(false)
	})

	it('a first record that is not session_started, and a session_started later on', () => {
		const lines = splitLog(readFileSync(join(FIXTURES, 'valid.jsonl'))).lines
		const first = JSON.parse(lines[0]?.bytes.toString('utf8') as string)
		const second = JSON.parse(lines[1]?.bytes.toString('utf8') as string)
		expect(SessionRecordSchema.safeParse({ ...second, seq: 1, prev: null }).success).toBe(false)
		expect(SessionRecordSchema.safeParse({ ...first, seq: 2, prev: second.prev }).success).toBe(
			false,
		)
	})

	it('a line that holds two records or is not JSON', () => {
		const line = splitLog(readFileSync(join(FIXTURES, 'valid.jsonl'))).lines[0]?.bytes as Buffer
		expect(() => parseSessionLogLine(Buffer.concat([line, line]))).toThrow(/more than one record/)
		expect(() => parseSessionLogLine('{not json}\n')).toThrow(SessionLogLineError)
		expect(() => parseSessionLogLine(Buffer.from([0xff, 0x0a]))).toThrow(/UTF-8/)
	})
})

function readRecords(name: string): SessionRecord[] {
	return splitLog(readFileSync(join(FIXTURES, name))).lines.map(
		(line) => parseSessionLogLine(line.bytes).record,
	)
}
