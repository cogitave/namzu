import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createUserMessage } from '../../../types/message/index.js'
import type { SessionEvent } from '../../../types/session/events.js'
import { asTurnId } from '../../../utils/id.js'
import { RunDiskStore } from '../../turn/disk.js'
import { compactionArchiveSchema } from '../compaction-archive.js'
import { compactedToolMetadata } from '../compaction-provenance.js'
import { createSessionTextEvidenceSource } from '../disk.js'
import type { SessionTextEvidenceSource } from '../types.js'

const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(mode: 'live' | 'closed' | 'snapshot', extraMessages?: unknown[]) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-evidence-selection-'))
	roots.push(root)
	const scope = {
		tenantId: randomUUID(),
		projectId: randomUUID(),
		sessionId: randomUUID(),
		turnId: asTurnId(randomUUID()),
	}
	const store = new RunDiskStore({ baseDir: root })
	const runDir = await store.initRun(scope.runId)
	await writeFile(
		join(runDir, 'run.json'),
		JSON.stringify({
			id: scope.runId,
			status: mode === 'closed' ? 'completed' : 'running',
			metadata: { scope },
		}),
	)
	const events = [
		{ type: 'turn_started' },
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
		events.push({
			type: 'compaction_shed',
			iteration: 2,
			reason: 'threshold',
			messages: extraMessages,
		} as (typeof events)[number])
	for (const [i, event] of events.entries())
		await store.appendEvent({ ...event, runId: scope.runId, seq: i + 1 } as SessionEvent)
	const source =
		mode === 'live'
			? (await store.captureTextEvidence(scope))!
			: createSessionTextEvidenceSource({
					scope,
					runDir,
					indexDir: join(runDir, 'evidence-index'),
					...(mode === 'snapshot' ? { consistency: 'snapshot' as const } : {}),
				})
	return { source, store, runDir }
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
		expect(before.matches.map((m) => m.seq).sort()).toEqual([2, 3, 4, 5, 6, 7])
		const copied = before.matches.find((m) => m.seq === 3)!
		const filtered = await all(source, ['archive_quote'])
		expect(filtered.matches.map((m) => m.seq).sort()).toEqual([2, 4, 5, 6, 7])
		expect(filtered.matches.find((m) => m.seq === 4)?.isError).toBe(true)
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
		const original = (await source.search({ query: 'ORCHID', seq: 8 })).matches
		expect(original).toHaveLength(4)
		expect(original[0]).toMatchObject({
			source: 'compaction_shed:tool',
			toolName: 'archive_quote',
			isError: false,
		})
		const filtered = await source.search({
			query: 'ORCHID',
			seq: 8,
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

it.each(['live', 'closed', 'snapshot'] as const)(
	'preserves provenance in spilled compaction without loading excluded payloads (%s)',
	async (mode) => {
		const messages = [
			createUserMessage('image attachment', [
				{ data: 'A'.repeat(4 * 1024 * 1024), mediaType: 'image/png' },
			]),
			call('success'),
			result('success', 'ORCHID archived copy', false),
			call('error'),
			result('error', 'ORCHID archived error', true),
		]
		const { source, store, runDir } = await fixture(mode, messages)
		const all = await source.search({ query: 'ORCHID', seq: 8 })
		expect(all.matches).toHaveLength(2)
		const text = await source.read({ address: all.matches[0]!.address })
		expect(text).toMatchObject({
			source: 'compaction_shed:tool',
			toolName: 'archive_quote',
			isError: false,
			text: 'ORCHID archived copy',
		})
		const saved = compactionArchiveSchema.parse(
			JSON.parse((await readFile(join(runDir, 'transcript.jsonl'), 'utf8')).trim().split('\n')[7]!),
		)
		expect(saved.archive.parts[1]).toMatchObject({ toolName: 'archive_quote', isError: false })
		expect((await store.readEvents()).at(-1)).toMatchObject({ type: 'compaction_shed', messages })
		// A filtered search need not open this intentionally excluded body. Exact access still verifies it.
		await rm(join(runDir, 'compaction-output', saved.archive.id, '1.txt.manifest.json'))
		const filtered = await source.search({
			query: 'ORCHID',
			seq: 8,
			excludeSuccessfulTools: ['archive_quote'],
		})
		expect(filtered.excludedToolResults).toBe(1)
		expect(filtered.matches).toHaveLength(1)
		expect(filtered.matches[0]).toMatchObject({ toolName: 'archive_quote', isError: true })
		await expect(source.read({ address: all.matches[0]!.address })).rejects.toThrow()
	},
)
