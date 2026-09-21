import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { buildCompactionMessage } from '../../../compaction/summary.js'
import type { Message, ToolResultBlock } from '../../../types/message/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { SessionTextEvidenceMatch, SessionTextEvidenceSource } from '../types.js'
import { evidenceSession } from './support/session-log.js'

const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function messages(blocks: readonly ToolResultBlock[]): Message[] {
	return [
		createUserMessage('ORCHID plain first'),
		{
			role: 'assistant',
			content: null,
			timestamp: 1,
			toolCalls: [{ id: 'one', type: 'function', function: { name: 'observe', arguments: '{}' } }],
		},
		{ role: 'tool', toolCallId: 'one', content: blocks, isError: false, timestamp: 2 },
		createUserMessage('ORCHID plain last'),
	]
}

/** The seq of the compaction pass: after `session_started` (1) and `turn_started` (2). */
const SHED_SEQ = 3

async function fixture(mode: 'live' | 'closed' | 'snapshot', removed: Message[]) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-rich-evidence-'))
	roots.push(root)
	const session = await evidenceSession(root)
	await session.append({
		type: 'compaction_shed',
		iteration: 0,
		reason: 'manual',
		messages: removed,
	})
	if (mode === 'closed') await session.close()
	const reopen = () => session.openTextSource(mode === 'closed' ? {} : { consistency: 'snapshot' })
	const source = await session.textSource(mode)
	/** The compaction pass as the log recorded it. */
	const shedRecord = async () =>
		(await session.log.readAll()).entries
			.map((entry) => entry.record as { type: string; messages?: unknown })
			.find((record) => record.type === 'compaction_shed')
	return { source, reopen, session, shedRecord }
}

async function all(source: SessionTextEvidenceSource, query: string) {
	const matches: SessionTextEvidenceMatch[] = []
	let cursor: string | undefined
	let pages = 0
	do {
		const page = await source.search({ query, cursor })
		matches.push(...page.matches)
		cursor = page.nextCursor ?? undefined
		expect(++pages).toBeLessThan(30)
	} while (cursor)
	return matches
}

it.each(['live', 'closed', 'snapshot'] as const)(
	'pages past derived summaries without reading their bodies, changing addresses or filtering lookalikes (%s)',
	async (mode) => {
		const removed: Message[] = [
			...Array.from({ length: 70 }, (_, i) => buildCompactionMessage(`ORCHID summary ${i}`)),
			{ role: 'system', content: 'ORCHID unmarked system source' },
			{ role: 'tool', toolCallId: 'original', content: 'ORCHID original A17', isError: false },
			...messages([{ type: 'image', mediaType: 'image/png', data: 'A' }]),
		]
		const f = await fixture(mode, removed)
		const known = (await f.source.search({ seq: SHED_SEQ, part: 0 })).matches[0]!
		let cursor: string | undefined
		let excluded = 0
		let pages = 0
		const found: SessionTextEvidenceMatch[] = []
		do {
			const page = await f.source.search({
				query: 'ORCHID',
				excludeDerivedSummaries: true,
				cursor,
				limit: 1,
			})
			expect(page.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
			expect(page.unavailable).toEqual([])
			// A reader over a turn still running (anchored or snapshot) is told
			// the evidence may grow.
			expect(page.incomplete).toBe(mode !== 'closed')
			excluded += page.excludedSummaries ?? 0
			found.push(...page.matches)
			cursor = page.nextCursor ?? undefined
			if (++pages === 1) {
				expect(page.matches).toEqual([])
				expect(page.excludedSummaries).toBe(64)
				expect(cursor).toBeDefined()
				for (const excludeDerivedSummaries of [undefined, false])
					await expect(
						f.source.search({ query: 'ORCHID', cursor, excludeDerivedSummaries }),
					).rejects.toThrow('Search cursor query changed')
			}
			expect(pages).toBeLessThan(12)
		} while (cursor)
		expect(excluded).toBe(70)
		expect(found.map((m) => m.part)).toEqual([70, 71, 72, 73])
		expect((await f.source.read({ address: found[1]!.address })).text).toBe('ORCHID original A17')
		expect((await f.source.read({ address: known.address })).text).toContain('ORCHID summary 0')
	},
)

it.each(['live', 'closed', 'snapshot'] as const)(
	'preserves summary provenance and addresses without classifying lookalike prose (%s)',
	async (mode) => {
		const summary = buildCompactionMessage('ORCHID derived receipt summary')
		const lookalike = {
			role: 'system' as const,
			content: summary.content as string,
		}
		const removed = [
			summary,
			lookalike,
			// Other roles and non-object source values cannot claim summary identity.
			{
				role: 'user',
				content: lookalike.content,
				source: { type: 'compaction-summary' },
			},
			{
				role: 'system',
				content: lookalike.content,
				source: [{ type: 'compaction-summary' }],
			},
			...messages([{ type: 'image', data: 'A', mediaType: 'image/png' }]),
		] as Message[]
		const f = await fixture(mode, removed)
		for (const source of [f.source, f.reopen()]) {
			for (const part of [0, 1, 2, 3]) {
				const found = (await source.search({ seq: SHED_SEQ, part })).matches[0]!
				expect(found.source).toBe(
					part === 0
						? 'compaction_shed:summary'
						: `compaction_shed:${part === 2 ? 'user' : 'system'}`,
				)
				expect(await source.read({ address: found.address })).toMatchObject({
					part,
					text: lookalike.content,
					source: found.source,
				})
			}
		}
		expect(await f.shedRecord()).toMatchObject({ messages: removed })
		const before = (await f.reopen().search({ seq: SHED_SEQ, part: 0 })).matches[0]!
		// The bytes the address names changed after it was issued.
		const text = await readFile(f.session.logPath, 'utf8')
		const changed = text.replace('"type":"compaction-summary"', '"type":"compaction-summarx"')
		expect(changed).not.toBe(text)
		await writeFile(f.session.logPath, changed)
		await expect(f.reopen().read({ address: before.address })).rejects.toThrow()
	},
)

it.each(['live', 'closed', 'snapshot'] as const)(
	'preserves exact rich text, binary separation and old plain-part addresses (%s)',
	async (mode) => {
		const first = 'ORCHID İ 😀\r\n first block\n'
		const last = 'ORCHID last block, no final newline'
		const original = messages([
			{ type: 'text', text: first },
			{ type: 'image', data: 'ONLY_BINARY', mediaType: 'image/png' },
			{ type: 'text', text: '' },
			{
				type: 'document',
				data: 'ONLY_BINARY',
				mediaType: 'application/pdf',
				name: 'ONLY_BINARY',
			},
			{ type: 'text', text: last },
		])
		const f = await fixture(mode, original)
		const found = await all(f.source, 'ORCHID')
		expect(found.map((m) => m.part)).toEqual([0, 1, 2, 4])
		// Bare seq/part addresses predate block indexing. They must never
		// silently start referring to a different message after an upgrade.
		const old = (await f.reopen().search({ seq: SHED_SEQ, part: 1 })).matches[0]!
		expect((await f.reopen().read({ address: old.address })).text).toBe('ORCHID plain last')
		for (const [part, text] of [
			[2, first],
			[3, ''],
			[4, last],
		] as const) {
			const match = (await f.reopen().search({ seq: SHED_SEQ, part })).matches[0]!
			expect(match).toMatchObject({
				source: 'compaction_shed:tool',
				toolName: 'observe',
				isError: false,
			})
			expect(await f.reopen().read({ address: match.address })).toMatchObject({
				text,
				part,
				retained: 'full',
				totalBytes: Buffer.byteLength(text),
				nextByteOffset: null,
			})
		}
		expect(await all(f.source, 'ONLY_BINARY')).toEqual([])
		const filtered = await f.source.search({
			query: 'ORCHID',
			excludeSuccessfulTools: ['observe'],
		})
		expect(filtered.matches.map((m) => m.part)).toEqual([0, 1])
		expect(await f.shedRecord()).toMatchObject({ messages: original })
	},
)

it('paginates rich-only messages beyond one index page after reopening', async () => {
	const removed = messages(
		Array.from({ length: 70 }, (_, i) => ({ type: 'text', text: `ORCHID block ${i}` })),
	)
	const f = await fixture('live', removed.slice(1, 3))
	// No plain message can accidentally keep a rich-only record in the text chain.
	await f.session.close()
	const live = await f.session.textSource('live')
	for (const source of [live, f.session.openTextSource()]) {
		const found = await all(source, 'ORCHID')
		expect(found.map((m) => m.part)).toEqual(Array.from({ length: 70 }, (_, i) => i))
		expect((await source.read({ address: found[69]!.address })).text).toBe('ORCHID block 69')
		const controller = new AbortController()
		controller.abort(new Error('stop rich retrieval'))
		await expect(source.search({ query: 'ORCHID' }, controller.signal)).rejects.toThrow(
			'stop rich retrieval',
		)
	}
})

it.each([
	null,
	{ type: 'text', text: 7 },
	{ type: 'other', text: 'ORCHID hidden' },
	{ type: 'image' },
])(
	'refuses malformed block arrays instead of reporting a complete empty history: %j',
	async (invalid) => {
		const f = await fixture('closed', messages([invalid as unknown as ToolResultBlock]))
		await expect(f.source.search({ query: 'ORCHID' })).rejects.toThrow(
			'Invalid shed tool content block',
		)
	},
)
