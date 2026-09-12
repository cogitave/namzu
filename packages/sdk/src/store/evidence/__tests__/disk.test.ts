import { createHmac, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyToolOutputBudget } from '../../../runtime/query/tool-output-budget.js'
import { createDiskRunEvidenceSource, createDiskRunTextEvidenceSource } from '../disk.js'
import { EVIDENCE_CHUNK_BYTES, digest } from '../format.js'
import { stamp } from '../io.js'
import type { RunEvidenceSearchResult, RunTextEvidenceSearchResult } from '../types.js'

const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(
	outputs: {
		text: string
		truncated?: boolean
		isError?: boolean
		spill?: boolean
		timestamp?: unknown
	}[],
) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-tool-evidence-'))
	roots.push(root)
	const runDir = join(root, 'run')
	const indexDir = join(root, 'index')
	await mkdir(runDir)
	await mkdir(indexDir)
	const scope = {
		tenantId: randomUUID(),
		projectId: randomUUID(),
		sessionId: randomUUID(),
		runId: randomUUID(),
	}
	await writeFile(
		join(runDir, 'run.json'),
		JSON.stringify({ id: scope.runId, metadata: { scope }, status: 'completed' }),
	)
	const events: object[] = [{ type: 'run_started', runId: scope.runId, seq: 1 }]
	for (const [index, output] of outputs.entries()) {
		const toolUseId = `call-${index}`
		const retained = output.spill
			? applyToolOutputBudget({
					toolUseId,
					toolName: 'observe',
					output: output.text,
					maxChars: 1000,
					spillDir: join(runDir, 'tool-output'),
				})
			: null
		events.push({
			type: 'tool_completed',
			runId: scope.runId,
			seq: index + 2,
			timestamp: output.timestamp,
			toolUseId,
			toolName: 'observe',
			isError: output.isError ?? false,
			result: retained?.output ?? output.text,
			outputTruncated: retained?.truncated ?? output.truncated ?? false,
			...(retained?.spillIntegrity ? { outputSpillIntegrity: retained.spillIntegrity } : {}),
			// A malicious path must never be followed; the identity derives the authorized file.
			outputSpillPath: '/outside/never-read',
		})
	}
	await writeFile(
		join(runDir, 'transcript.jsonl'),
		events.map((event) => JSON.stringify(event)).join('\n') + '\n',
	)
	const options = { scope, runDir, indexDir }
	return {
		...options,
		source: createDiskRunEvidenceSource(options),
		reopen: () => createDiskRunEvidenceSource(options),
	}
}

describe('bounded retained tool evidence', () => {
	it('crosses many compacted messages without rereading the shared record for every part', async () => {
		const f = await fixture([])
		const path = join(f.runDir, 'transcript.jsonl')
		const messages = Array.from({ length: 128 }, (_, part) => ({
			role: 'user',
			content: `${'ordinary '.repeat(900)} ${part === 127 ? 'ORCHID-PAGE-RECEIPT' : ''}`,
		}))
		await writeFile(
			path,
			`${await readFile(path, 'utf8')}${JSON.stringify({
				type: 'compaction_shed',
				runId: f.scope.runId,
				seq: 2,
				messages,
			})}\n`,
		)
		for (const _phase of ['cold', 'warm']) {
			const source = createDiskRunTextEvidenceSource(f)
			let cursor: string | undefined
			let bytes = 0
			const matches = []
			for (let page = 0; page < 2; page++) {
				const result = await source.search({
					query: 'orchid-page-receipt',
					caseSensitive: false,
					cursor,
				})
				expect(result.incomplete).toBe(false)
				bytes += result.scannedBytes
				matches.push(...result.matches)
				cursor = result.nextCursor ?? undefined
				if (!cursor) break
			}
			expect(cursor).toBeUndefined()
			expect(bytes).toBeLessThan(5 * 1024 * 1024)
			expect(matches).toHaveLength(1)
			expect(matches[0]).toMatchObject({ seq: 2, part: 127 })
			const read = await source.read({
				address: matches[0]!.address,
				byteOffset: matches[0]!.byteOffset,
			})
			expect(read.text).toContain('ORCHID-PAGE-RECEIPT')
		}
	})

	it.each([false, true])(
		'recovers stored event time through cache and exact reads (spill=%s)',
		async (spill) => {
			const recordedAt = Date.UTC(2025, 0, 2, 3, 4, 5)
			const f = await fixture([
				{
					text: `${spill ? 'padding '.repeat(1000) : ''}DELTA receipt`,
					timestamp: recordedAt,
					spill,
				},
			])
			for (const source of [f.source, f.reopen()]) {
				const page = await source.search({ query: 'DELTA' })
				expect(page.matches[0]?.recordedAt).toBe(recordedAt)
				expect((await source.read({ address: page.matches[0]!.address })).recordedAt).toBe(
					recordedAt,
				)
			}
		},
	)

	it.each([undefined, 0, -1, 1.5, '2025-01-02', null, 8_640_000_000_000_001])(
		'leaves missing or invalid time unknown (%j)',
		async (timestamp) => {
			const f = await fixture([{ text: 'DELTA receipt', timestamp }])
			const match = (await f.source.search()).matches[0]!
			expect(match.recordedAt).toBeUndefined()
			expect((await f.source.read({ address: match.address })).recordedAt).toBeUndefined()
		},
	)

	it('dates a compaction copy by its own event without inventing an original message date', async () => {
		const f = await fixture([])
		const path = join(f.runDir, 'transcript.jsonl')
		const recordedAt = Date.UTC(2026, 0, 1)
		await writeFile(
			path,
			`${await readFile(path, 'utf8')}${JSON.stringify({
				type: 'compaction_shed',
				runId: f.scope.runId,
				seq: 2,
				timestamp: recordedAt,
				messages: [{ role: 'tool', content: 'DELTA receipt from 2020', timestamp: 1 }],
			})}\n`,
		)
		const source = createDiskRunTextEvidenceSource(f)
		const match = (await source.search({ query: 'DELTA' })).matches[0]!
		expect(match.source).toBe('compaction_shed:tool')
		expect(match.recordedAt).toBe(recordedAt)
		expect((await source.read({ address: match.address })).recordedAt).toBe(recordedAt)
	})

	it('keeps previously issued tool-only addresses readable when rebuilding the text index', async () => {
		const f = await fixture([{ text: 'original tool address' }])
		const match = (await f.source.search()).matches[0]!
		const body = JSON.parse(Buffer.from(match.address.split('.')[0]!, 'base64url').toString('utf8'))
		delete body.entry.part // The previous pointer format predates textual part indices.
		const encoded = Buffer.from(JSON.stringify(body)).toString('base64url')
		const scopeKey = digest(JSON.stringify(f.scope))
		const meta = await readFile(join(f.runDir, 'run.json'))
		const sourceKey = digest(
			`${scopeKey}:${stamp(await lstat(join(f.runDir, 'transcript.jsonl')))}:${digest(meta)}`,
		)
		const key = await readFile(join(f.indexDir, scopeKey, 'key'))
		const signature = createHmac('sha256', key)
			.update(`${sourceKey}\n${encoded}`)
			.digest('base64url')
		expect((await f.reopen().read({ address: `${encoded}.${signature}` })).text).toBe(
			'original tool address',
		)
	})

	it('indexes assistant output and more than one page of shed parts without losing identity', async () => {
		const f = await fixture([{ text: 'shared tool result' }])
		const path = join(f.runDir, 'transcript.jsonl')
		const events = [
			{ type: 'message_completed', runId: f.scope.runId, seq: 3, content: 'shared assistant 🦉' },
			{
				type: 'compaction_shed',
				runId: f.scope.runId,
				seq: 4,
				messages: [
					{ role: 'assistant', content: [{ type: 'image' }] },
					...Array.from({ length: 130 }, (_, part) => ({
						role: 'user',
						content: `shared shed ${part}`,
					})),
				],
			},
		]
		await writeFile(
			path,
			(await readFile(path, 'utf8')) + events.map((e) => JSON.stringify(e)).join('\n') + '\n',
		)
		let cursor: string | null = null
		const matches = []
		let calls = 0
		do {
			const page: RunTextEvidenceSearchResult = await createDiskRunTextEvidenceSource(f).search({
				query: 'shared',
				cursor: cursor ?? undefined,
			})
			expect(page.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
			matches.push(...page.matches)
			cursor = page.nextCursor
			expect(++calls).toBeLessThan(50)
		} while (cursor)
		expect(matches.map((m) => [m.seq, m.part])).toEqual([
			[2, 0],
			[3, 0],
			...Array.from({ length: 130 }, (_, part) => [4, part]),
		])
		const source = createDiskRunTextEvidenceSource(f)
		const read = await source.read({ address: matches[1]!.address })
		expect(read).toMatchObject({
			text: 'shared assistant 🦉',
			source: 'message_completed',
			part: 0,
			characterOffset: 0,
			totalChars: 19,
		})
		const tools = await f.source.search({ query: 'shared' })
		expect(tools.matches.map((m) => m.seq)).toEqual([2])
		await expect(f.source.read({ address: matches[1]!.address })).rejects.toThrow()
		let located = await source.search({ seq: 4, part: 129 })
		while (located.nextCursor && !located.matches.length)
			located = await source.search({ seq: 4, part: 129, cursor: located.nextCursor })
		expect(located.matches[0]?.excerpt).toBe('shared shed 129')
		await expect(source.search({ seq: 4, part: 128, cursor: tools.nextCursor! })).rejects.toThrow()
	})

	it('maps byte offsets back to exact UTF-16 positions across Unicode chunk boundaries', async () => {
		const prefix = '\ufeff' + 'α🦉\r\n'.repeat(30_000)
		const full = prefix + 'UNIQUE-RECEIPT' + 'β'.repeat(40_000)
		const f = await fixture([{ text: full, spill: true }])
		const source = createDiskRunTextEvidenceSource(f)
		const result = await source.search({ query: 'UNIQUE-RECEIPT' })
		const match = result.matches[0]!
		const near = await source.read({ address: match.address, byteOffset: match.byteOffset })
		expect(near.text).toContain('UNIQUE-RECEIPT')
		expect(near.characterOffset).toBe(
			Buffer.from(full).subarray(0, near.byteOffset).toString('utf8').length,
		)
		expect(near.totalChars).toBe(full.length)
		expect(full.slice(near.characterOffset, near.characterOffset! + near.text.length)).toBe(
			near.text,
		)
		let offset: number | null = 0
		let chars = 0
		while (offset !== null) {
			const page = await source.read({ address: match.address, byteOffset: offset })
			expect(page.characterOffset).toBe(chars)
			chars += page.text.length
			offset = page.nextByteOffset
		}
		expect(chars).toBe(full.length)
	})

	it('rebuilds a damaged cache or a valid page copied into the wrong index position', async () => {
		const f = await fixture(
			Array.from({ length: 75 }, (_, i) => ({
				text: i === 0 ? 'EARLY RECEIPT' : 'ordinary output',
			})),
		)
		let page = await f.source.search({ query: 'absent' })
		while (page.nextCursor)
			page = await f.source.search({ query: 'absent', cursor: page.nextCursor })
		const directory = join(f.indexDir, (await readdir(f.indexDir))[0]!)
		const pages = await Promise.all(
			(await readdir(directory))
				.filter((name) => name.endsWith('.page'))
				.map(async (name) => {
					const path = join(directory, name)
					const text = await readFile(path, 'utf8')
					const body = JSON.parse(Buffer.from(text.split('.')[0]!, 'base64url').toString('utf8'))
					return { path, text, offset: body.start.offset }
				}),
		)
		pages.sort((a, b) => a.offset - b.offset)
		await writeFile(pages[0]!.path, pages[1]!.text)
		const rebuilt = await f.reopen().search({ query: 'EARLY' })
		expect(rebuilt.cacheHit).toBe(false)
		expect(rebuilt.matches[0]?.excerpt).toBe('EARLY RECEIPT')
		await writeFile(pages[0]!.path, 'damaged derived cache')
		expect((await f.reopen().search({ query: 'EARLY' })).matches[0]?.excerpt).toBe('EARLY RECEIPT')
	})

	it('pages a durable index across restart without collapsing equal tool results', async () => {
		const f = await fixture(
			Array.from({ length: 75 }, (_, i) => ({
				text: i > 63 ? 'late evidence' : 'same early evidence',
			})),
		)
		const first = await f.source.search({ query: 'late evidence' })
		expect(first.matches).toHaveLength(0)
		expect(first.nextCursor).not.toBeNull()
		expect(first.indexedRecords).toBe(64)
		const cached = await f.reopen().search({ query: 'late evidence' })
		expect(cached.cacheHit).toBe(true)
		expect(cached.indexedRecords).toBe(0)
		expect(cached.scannedBytes).toBeLessThan(200_000)
		const found: number[] = []
		let cursor = first.nextCursor
		while (cursor) {
			const page: RunEvidenceSearchResult = await f
				.reopen()
				.search({ query: 'late evidence', cursor })
			found.push(...page.matches.map((match) => match.seq))
			cursor = page.nextCursor
		}
		expect(found).toEqual(Array.from({ length: 11 }, (_, i) => 66 + i))
	})

	it('retrieves an original 10 MiB spill at a cross-chunk Unicode match without rereading it whole', async () => {
		const prefix = 'x'.repeat(EVIDENCE_CHUNK_BYTES * 80 - 8)
		const needle = 'DELIVERY 🦉 İstanbul'
		const full = prefix + needle + 'z'.repeat(5 * 1024 * 1024)
		const f = await fixture([{ text: full, spill: true }])
		const result = await f.source.search({ query: needle })
		expect(result.incomplete).toBe(false)
		expect(result.matches.length).toBeGreaterThan(0)
		expect(result.scannedBytes).toBeLessThan(1_000_000)
		const match = result.matches[0]!
		expect(match.retained).toBe('full')
		const read = await f.reopen().read({ address: match.address, byteOffset: match.byteOffset })
		expect(read.text).toContain(needle)
		expect(read.text).toBe(
			Buffer.from(full)
				.subarray(read.byteOffset, read.byteOffset + Buffer.byteLength(read.text))
				.toString('utf8'),
		)
		expect(read.scannedBytes).toBeLessThan(1_000_000)
		expect(read.text.length).toBeLessThanOrEqual(6000)
	})

	it('reads every UTF-8 byte once through exact continuation offsets, including chunk edges', async () => {
		const full = '\ufeff' + 'α🦉\r\n\ufeff\0'.repeat(12_000)
		const f = await fixture([{ text: full, spill: true }])
		const address = (await f.source.search()).matches[0]!.address
		let offset: number | null = 0
		let recovered = ''
		while (offset !== null) {
			const page = await f.reopen().read({ address, byteOffset: offset })
			recovered += page.text
			expect(page.text.length).toBeLessThanOrEqual(6000)
			offset = page.nextByteOffset
		}
		expect(recovered).toBe(full)
		await expect(f.source.read({ address, byteOffset: 1 })).rejects.toThrow()
	})

	it('refuses changed or missing spill bytes and does not silently return the preview', async () => {
		const f = await fixture([{ text: 'retained secret '.repeat(8000), spill: true }])
		const address = (await f.source.search()).matches[0]!.address
		const spill = join(f.runDir, 'tool-output', `${digest('call-0')}.txt`)
		const bytes = await readFile(spill)
		bytes[0] = 65
		await writeFile(spill, bytes)
		await expect(f.reopen().read({ address })).rejects.toThrow('changed')
		const search = await f.reopen().search({ query: 'secret' })
		expect(search.matches).toHaveLength(0)
		expect(search.incomplete).toBe(true)
		await rm(spill)
		await expect(f.source.read({ address })).rejects.toThrow()
	})

	it('distinguishes legacy partial text and error output, including a negative query', async () => {
		const f = await fixture([{ text: 'only preview', truncated: true, isError: true }])
		expect((await f.source.search({ query: 'missing' })).incomplete).toBe(true)
		const match = (await f.source.search()).matches[0]!
		expect(match).toMatchObject({ retained: 'preview', isError: true })
		expect(await f.source.read({ address: match.address })).toMatchObject({
			text: 'only preview',
			retained: 'preview',
			isError: true,
		})
	})

	it('binds addresses to the authorized invocation and refuses live or changed sources', async () => {
		const a = await fixture([{ text: 'private result' }])
		const b = await fixture([{ text: 'other result' }])
		const address = (await a.source.search()).matches[0]!.address
		await expect(b.source.read({ address })).rejects.toThrow('different scope')
		await expect(createDiskRunEvidenceSource({ ...a, scope: b.scope }).search()).rejects.toThrow(
			'authorized scope',
		)
		await writeFile(join(a.runDir, 'transcript.jsonl'), 'changed\n')
		await expect(a.source.read({ address })).rejects.toThrow('changed source')
		await writeFile(
			join(b.runDir, 'run.json'),
			JSON.stringify({ id: b.scope.runId, metadata: { scope: b.scope }, status: 'running' }),
		)
		await expect(b.source.search()).rejects.toThrow('not closed')
	})

	it('refuses altered cursors, symlinks, torn records and cancellation', async () => {
		const f = await fixture(Array.from({ length: 70 }, () => ({ text: 'ordinary' })))
		const cursor = (await f.source.search({ query: 'absent' })).nextCursor!
		await expect(f.reopen().search({ query: 'changed', cursor })).rejects.toThrow('query changed')
		await expect(f.reopen().search({ query: 'absent', cursor: `x${cursor}` })).rejects.toThrow()
		await expect(f.source.search({}, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow(
			'cancelled',
		)
		const transcript = join(f.runDir, 'transcript.jsonl')
		await writeFile(transcript, '{"type":"run_started"')
		await expect(f.source.search()).rejects.toThrow('torn')
		await rm(transcript)
		await symlink(join(f.runDir, 'run.json'), transcript)
		await expect(f.source.search()).rejects.toThrow()
	})
})
