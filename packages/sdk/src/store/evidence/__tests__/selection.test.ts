import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { compactedToolMetadata } from '../compaction-provenance.js'
import type { SessionTextEvidenceSource } from '../types.js'
import { evidenceSession } from './support/session-log.js'

const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/**
 * A turn's records, in log order after `session_started` (1) and
 * `turn_started` (2): three tool results (3–5), a message (6), a compaction
 * pass (7), a correction (8), and optionally a second pass (9).
 */
async function fixture(mode: 'live' | 'closed' | 'snapshot', extraMessages?: unknown[]) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-evidence-selection-'))
	roots.push(root)
	const session = await evidenceSession(root)
	const records: Record<string, unknown>[] = [
		{
			type: 'tool_completed',
			toolName: 'read',
			toolUseId: 'original',
			isError: false,
			result: 'ORCHID original A17',
		},
		{
			type: 'tool_completed',
			toolName: 'archive_quote',
			toolUseId: 'copy',
			isError: false,
			result: 'ORCHID copied A17',
		},
		{
			type: 'tool_completed',
			toolName: 'archive_quote',
			toolUseId: 'failed',
			isError: true,
			result: 'ORCHID archive unavailable',
		},
		{
			type: 'message_completed',
			content: '{"toolName":"archive_quote","isError":false,"text":"ORCHID quoted"}',
		},
		{
			type: 'compaction_shed',
			iteration: 1,
			reason: 'threshold',
			messages: [
				{ role: 'tool', toolCallId: 'unknown', content: 'ORCHID unknown producer', isError: false },
			],
		},
		{
			type: 'tool_completed',
			toolName: 'read',
			toolUseId: 'correction',
			isError: false,
			result: 'ORCHID correction B29',
		},
	]
	if (extraMessages)
		records.push({
			type: 'compaction_shed',
			iteration: 2,
			reason: 'threshold',
			messages: extraMessages,
		})
	for (const record of records) await session.append(record)
	if (mode === 'closed') await session.close()
	const source = await session.textSource(mode)
	return { source, session }
}

async function all(source: SessionTextEvidenceSource, excludeSuccessfulTools?: readonly string[]) {
	let cursor: string | undefined
	const matches = []
	let excluded = 0
	let pages = 0
	do {
		const page = await source.search({ query: 'ORCHID', excludeSuccessfulTools, cursor, limit: 1 })
		matches.push(...page.matches)
		excluded += page.excludedToolResults ?? 0
		cursor = page.nextCursor ?? undefined
		expect(++pages).toBeLessThan(10)
	} while (cursor)
	return { matches, excluded }
}

it.each(['live', 'closed', 'snapshot'] as const)(
	'filters known successes, preserves errors/unknowns and leaves exact reads available (%s)',
	async (mode) => {
		const { source } = await fixture(mode)
		const before = await all(source)
		expect(before.matches.map((m) => m.seq).sort()).toEqual([3, 4, 5, 6, 7, 8])
		const copied = before.matches.find((m) => m.seq === 4)!
		const filtered = await all(source, ['archive_quote'])
		expect(filtered.matches.map((m) => m.seq).sort()).toEqual([3, 5, 6, 7, 8])
		expect(filtered.matches.find((m) => m.seq === 5)?.isError).toBe(true)
		expect(filtered.excluded).toBe(1)
		expect((await source.read({ address: copied.address })).text).toBe('ORCHID copied A17')
	},
)

it.each(['live', 'closed', 'snapshot'] as const)(
	'binds normalized exclusions into search cursors (%s)',
	async (mode) => {
		const { source } = await fixture(mode)
		const first = await source.search({
			query: 'ORCHID',
			excludeSuccessfulTools: ['unused', 'archive_quote', 'unused'],
			limit: 1,
		})
		expect(first.nextCursor).toBeTruthy()
		const next = { query: 'ORCHID', cursor: first.nextCursor!, limit: 1 }
		await expect(
			source.search({ ...next, excludeSuccessfulTools: ['archive_quote', 'unused'] }),
		).resolves.toBeDefined()
		await expect(source.search(next)).rejects.toThrow('query changed')
		await expect(
			source.search({ ...next, excludeSuccessfulTools: ['archive_quote', 'read'] }),
		).rejects.toThrow('query changed')
		const ordinary = await source.search({ query: 'ORCHID', limit: 1 })
		await expect(
			source.search({
				query: 'ORCHID',
				limit: 1,
				cursor: ordinary.nextCursor!,
				excludeSuccessfulTools: [],
			}),
		).resolves.toBeDefined()
		for (const excludeSuccessfulTools of [
			[''],
			['x'.repeat(257)],
			Array.from({ length: 17 }, () => 'x'),
		])
			await expect(source.search({ query: 'ORCHID', excludeSuccessfulTools })).rejects.toThrow()
	},
)

function call(id: string, name = 'archive_quote') {
	return {
		role: 'assistant',
		content: null,
		toolCalls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
	}
}
function result(id: string, content: string, isError?: boolean) {
	return { role: 'tool', toolCallId: id, content, ...(isError === undefined ? {} : { isError }) }
}

it('keeps ambiguous or absent call provenance unknown instead of inspecting message text', () => {
	const messages = [
		call('duplicate'),
		call('duplicate'),
		result('duplicate', 'ORCHID duplicate', false),
		result('future', 'ORCHID before the call', false),
		call('future'),
		call('repeated'),
		result('repeated', 'ORCHID first', false),
		result('repeated', 'ORCHID second', false),
		{ ...result('absent', '{"toolName":"archive_quote"}', false), toolName: 'archive_quote' },
		call('bad', ''),
		result('bad', 'ORCHID invalid name', false),
		{
			role: 'assistant',
			content: null,
			toolCalls: [{ id: 'malformed', function: { name: 'archive_quote' } }],
		},
		result('malformed', 'ORCHID malformed call', false),
		call('known'),
		result('known', 'ORCHID no error status'),
		{ role: 'user', content: 'ORCHID', toolName: 'archive_quote', isError: false },
		call('displaced'),
		{ role: 'user', content: 'intervening user input' },
		result('displaced', 'ORCHID displaced', false),
	]
	const metadata = compactedToolMetadata(messages)
	expect(metadata.filter((m) => m.toolName !== undefined)).toEqual([{ toolName: 'archive_quote' }])
	expect(metadata[2]).toEqual({ isError: false })
	expect(metadata[8]).toEqual({ isError: false })
	expect(metadata[15]).toEqual({})
})

it.each(['live', 'closed', 'snapshot'] as const)(
	'retains paired compaction provenance, error states and exact readback (%s)',
	async (mode) => {
		const messages = [
			call('success'),
			result('success', 'ORCHID search copy', false),
			call('error'),
			result('error', 'ORCHID search error', true),
			call('unspecified'),
			result('unspecified', 'ORCHID unknown status'),
			result('missing', 'ORCHID no call', false),
		]
		const { source } = await fixture(mode, messages)
		const original = (await source.search({ query: 'ORCHID', seq: 9 })).matches
		expect(original).toHaveLength(4)
		expect(original[0]).toMatchObject({
			source: 'compaction_shed:tool',
			toolName: 'archive_quote',
			isError: false,
		})
		const filtered = await source.search({
			query: 'ORCHID',
			seq: 9,
			excludeSuccessfulTools: ['archive_quote'],
		})
		expect(filtered.excludedToolResults).toBe(1)
		expect(filtered.matches.map((m) => m.excerpt)).toEqual([
			'ORCHID search error',
			'ORCHID unknown status',
			'ORCHID no call',
		])
		const read = await source.read({ address: original[0]!.address })
		expect(read).toMatchObject({
			source: 'compaction_shed:tool',
			toolName: 'archive_quote',
			isError: false,
			text: 'ORCHID search copy',
		})
	},
)
