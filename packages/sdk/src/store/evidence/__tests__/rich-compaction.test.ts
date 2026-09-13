import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Message, ToolResultBlock } from '../../../types/message/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import { asRunId } from '../../../utils/id.js'
import { RunDiskStore } from '../../run/disk.js'
import { compactionArchiveSchema, compactionPartPath } from '../compaction-archive.js'
import { createDiskRunTextEvidenceSource } from '../disk.js'
import type { RunTextEvidenceMatch, RunTextEvidenceSource } from '../types.js'

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

async function fixture(mode: 'live' | 'closed' | 'snapshot', removed: Message[]) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-rich-evidence-'))
	roots.push(root)
	const scope = {
		tenantId: randomUUID(),
		projectId: randomUUID(),
		sessionId: randomUUID(),
		runId: asRunId(randomUUID()),
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
	await store.appendEvent({ type: 'run_started', runId: scope.runId, seq: 1 })
	await store.appendEvent({
		type: 'compaction_shed',
		runId: scope.runId,
		seq: 2,
		iteration: 0,
		reason: 'manual',
		messages: removed,
	})
	const reopen = () =>
		createDiskRunTextEvidenceSource({
			scope,
			runDir,
			indexDir: join(runDir, 'evidence-index'),
			...(mode === 'closed' ? {} : { consistency: 'snapshot' as const }),
		})
	const source = mode === 'live' ? (await store.captureTextEvidence(scope))! : reopen()
	return { source, reopen, store, scope, runDir }
}

async function all(source: RunTextEvidenceSource, query: string) {
	const matches: RunTextEvidenceMatch[] = []
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
	'preserves exact rich text, binary separation and old plain-part addresses (%s)',
	async (mode) => {
		for (const archived of [false, true]) {
			const first = 'ORCHID İ 😀\r\n first block\n'
			const last = 'ORCHID last block, no final newline'
			const original = messages([
				{ type: 'text', text: first },
				{
					type: 'image',
					data: archived ? 'A'.repeat(4 * 1024 * 1024) : 'ONLY_BINARY',
					mediaType: 'image/png',
				},
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
			const old = (await f.reopen().search({ seq: 2, part: 1 })).matches[0]!
			expect((await f.reopen().read({ address: old.address })).text).toBe('ORCHID plain last')
			for (const [part, text] of [
				[2, first],
				[3, ''],
				[4, last],
			] as const) {
				const match = (await f.reopen().search({ seq: 2, part })).matches[0]!
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
			expect((await f.store.readEvents()).find((e) => e.type === 'compaction_shed')).toMatchObject({
				messages: original,
			})
			const event = JSON.parse(
				(await readFile(join(f.runDir, 'transcript.jsonl'), 'utf8')).trim().split('\n')[1]!,
			)
			expect(event.type).toBe(archived ? 'compaction_archive' : 'compaction_shed')
			if (archived) {
				const saved = compactionArchiveSchema.parse(event)
				await writeFile(compactionPartPath(f.runDir, saved.archive.id, 2), 'ORCHID modified')
				await expect(f.source.read({ address: found[2]!.address })).rejects.toThrow()
			}
		}
	},
)

it('paginates rich-only messages beyond one index page after reopening', async () => {
	const removed = messages(
		Array.from({ length: 70 }, (_, i) => ({ type: 'text', text: `ORCHID block ${i}` })),
	)
	const f = await fixture('live', removed.slice(1, 3))
	// No plain message can accidentally keep a rich-only record in the text chain.
	await f.store.appendEvent({ type: 'run_completed', runId: f.scope.runId, seq: 3, result: '' })
	const live = (await f.store.captureTextEvidence(f.scope))!
	for (const source of [live, f.reopen()]) {
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
