import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordTexts } from '../../evidence/index-page.js'
import { passageMatcher } from '../../evidence/passages.js'
import { EvidenceQueryError, evidenceMatcher, evidenceTexts, ftsMatchExpression } from '../fts.js'
import type { EvidenceHit, SessionIndex } from '../index.js'
import { discoverSessionLogs, readIndexableRecords } from '../rebuild.js'
import { ScanSessionIndex } from '../scan.js'
import { SqliteSessionIndex } from '../sqlite.js'
import { QUERIES, SLUG, homeWithFixtures, syntheticLog } from './support.js'

let root: string
let home: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-session-index-'))
	home = join(root, 'home')
	homeWithFixtures(home)
	// Text that exercises Unicode case folding: U+212A KELVIN SIGN, U+00DF and U+017F LONG S.
	const { sessionId, text } = syntheticLog('unicode', 3, (turn) =>
		turn === 1
			? 'Temperature in Kelvin: 300 K.'
			: turn === 2
				? 'Straße, STRASSE and a long ſword.'
				: `emoji \u{1F600} ${'x'.repeat(200)} needle`,
	)
	writeFileSync(join(home, 'projects', SLUG, `${sessionId}.jsonl`), text)
	// A compaction that shed tool output: its parts carry the tool's name and error flag.
	const shed = syntheticLog(
		'shed-tools',
		1,
		() => 'Compacted the tool output.',
		() => [
			{
				role: 'assistant',
				content: '',
				toolCalls: [
					{ id: 'call-read', type: 'function', function: { name: 'read_file', arguments: '{}' } },
					{ id: 'call-grep', type: 'function', function: { name: 'grep', arguments: '{}' } },
				],
			},
			{ role: 'tool', toolCallId: 'call-read', content: 'shed tool text from read_file' },
			{
				role: 'tool',
				toolCallId: 'call-grep',
				isError: true,
				content: [{ type: 'text', text: 'shed tool block from grep failed' }],
			},
		],
	)
	writeFileSync(join(home, 'projects', SLUG, `${shed.sessionId}.jsonl`), shed.text)
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

/**
 * Today's evidence search, applied to the same records: `recordTexts` picks
 * the text parts and `passageMatcher` finds the first passage in each, as
 * `store/evidence/disk.ts` does for a run's event log.
 */
async function todaysSearch(query: (typeof QUERIES)[number]): Promise<EvidenceHit[]> {
	const hits: EvidenceHit[] = []
	const logs = await discoverSessionLogs(home)
	const match = passageMatcher(
		query.terms ?? query.query ?? '',
		query.caseSensitive ?? true,
		query.matchMode,
	)
	for (const log of logs) {
		for await (const { record } of readIndexableRecords(log.logPath)) {
			const parts = recordTexts(record as unknown as Record<string, unknown>)
			parts.forEach((part, index) => {
				const passage = match(part.text, 0)
				if (passage === undefined) return
				hits.push({
					sessionId: record.sessionId,
					...(record.turnId === undefined ? {} : { turnId: record.turnId }),
					seq: record.seq,
					part: index,
					source: part.source,
					...(record.type === 'tool_completed'
						? { toolName: record.toolName, isError: record.isError }
						: {
								...(part.toolName === undefined ? {} : { toolName: part.toolName }),
								...(part.isError === undefined ? {} : { isError: part.isError }),
							}),
					hit: passage.hit,
					excerpt: part.text.slice(passage.start, passage.end),
				})
			})
		}
	}
	return hits.sort((a, b) =>
		a.sessionId !== b.sessionId
			? a.sessionId < b.sessionId
				? -1
				: 1
			: a.seq !== b.seq
				? a.seq - b.seq
				: a.part - b.part,
	)
}

const ALL_QUERIES = [
	...QUERIES,
	{ query: 'kelvin', caseSensitive: false },
	{ query: 'KELVIN', caseSensitive: false },
	{ query: 'sword', caseSensitive: false },
	{ query: 'strasse', caseSensitive: false },
	{ query: 'needle' },
	{ query: 'Kelvin', matchMode: 'token' as const, caseSensitive: false },
	{ query: 'summary' },
	{ query: 'Earlier' },
	{ query: 'summary', matchMode: 'token' as const },
	{ query: 'shed tool' },
]

describe.each([
	{
		name: 'sqlite',
		open: () => SqliteSessionIndex.open({ home, path: join(root, 'index.sqlite') }),
	},
	{ name: 'scan', open: () => ScanSessionIndex.load(home) },
] as { name: string; open(): Promise<SessionIndex> }[])('$name', (backend) => {
	it('returns exactly the hits today’s evidence search finds on the fixtures', async () => {
		const index = await backend.open()
		try {
			let nonEmpty = 0
			for (const query of ALL_QUERIES) {
				const expected = await todaysSearch(query)
				if (expected.length > 0) nonEmpty++
				expect(
					await index.searchEvidence({ ...query, limit: 10_000 }),
					JSON.stringify(query),
				).toEqual(expected)
			}
			expect(nonEmpty).toBeGreaterThan(10)
		} finally {
			index.close()
		}
	})

	it('narrows to one session and stops at the limit', async () => {
		const index = await backend.open()
		try {
			const all = await index.searchEvidence({ query: '', limit: 10_000 })
			const first = all[0]
			if (first === undefined) throw new Error('no evidence')
			const one = await index.searchEvidence({ query: '', sessionId: first.sessionId })
			expect(one.every((hit) => hit.sessionId === first.sessionId)).toBe(true)
			expect(one.length).toBeGreaterThan(0)
			expect(await index.searchEvidence({ query: '', limit: 3 })).toEqual(all.slice(0, 3))
		} finally {
			index.close()
		}
	})
})

describe('evidence rules', () => {
	it('extracts the same text parts as today’s extraction', async () => {
		for (const log of await discoverSessionLogs(home)) {
			for await (const { record } of readIndexableRecords(log.logPath)) {
				const today = recordTexts(record as unknown as Record<string, unknown>)
				const expected =
					record.type === 'tool_completed'
						? today.map((part) => ({
								...part,
								toolName: record.toolName,
								isError: record.isError,
							}))
						: today
				expect(evidenceTexts(record).map(({ part: _, ...text }) => text)).toEqual(expected)
			}
		}
	})

	it('keeps the tool name and error flag of shed tool output', async () => {
		const index = await ScanSessionIndex.load(home)
		try {
			const hits = await index.searchEvidence({ query: 'shed tool', limit: 100 })
			expect(hits.map(({ source, toolName, isError }) => ({ source, toolName, isError }))).toEqual([
				{ source: 'compaction_shed:tool', toolName: 'read_file', isError: undefined },
				{ source: 'compaction_shed:tool', toolName: 'grep', isError: true },
			])
		} finally {
			index.close()
		}
	})

	it('refuses the queries today’s search refuses', () => {
		expect(() => evidenceMatcher({ query: 'a', terms: ['b'] })).toThrow(EvidenceQueryError)
		expect(() => evidenceMatcher({ terms: [] })).toThrow(EvidenceQueryError)
		expect(() => evidenceMatcher({ terms: ['  '] })).toThrow(EvidenceQueryError)
		expect(() => evidenceMatcher({ query: 'two words', matchMode: 'token' })).toThrow(
			EvidenceQueryError,
		)
	})

	it('narrows with FTS only where narrowing cannot drop a hit', () => {
		expect(ftsMatchExpression({ query: 'needle' })).toBe('"needle"')
		expect(ftsMatchExpression({ terms: ['say "hi"', 'abc'] })).toBe('"say ""hi""" OR "abc"')
		expect(ftsMatchExpression({ query: 'ab' })).toBeUndefined()
		expect(ftsMatchExpression({ query: '' })).toBeUndefined()
		expect(ftsMatchExpression({ query: 'Straße' })).toBeUndefined()
		expect(ftsMatchExpression({ query: 'tab\there' })).toBeUndefined()
		expect(ftsMatchExpression({ query: 'kelvin', caseSensitive: false })).toBeUndefined()
		expect(ftsMatchExpression({ query: 'kelvin' })).toBe('"kelvin"')
		expect(ftsMatchExpression({ query: 'needle', caseSensitive: false })).toBe('"needle"')
	})
})
