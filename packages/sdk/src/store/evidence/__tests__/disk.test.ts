import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyToolOutputBudget } from '../../../runtime/query/tool-output-budget.js'
import { createSessionEvidenceSource, createSessionTextEvidenceSource } from '../disk.js'
import { EVIDENCE_CHUNK_BYTES, digest } from '../format.js'
import type { SessionEvidenceSearchResult, SessionTextEvidenceSearchResult } from '../types.js'
import { evidenceSession } from './support/session-log.js'

const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/**
 * A session log holding one turn: `session_started` (1), `turn_started` (2),
 * one `tool_completed` per output (from 3), then `extra` records, then —
 * unless `open` — the turn's `turn_completed`.
 */
async function fixture(
	outputs: {
		text: string
		truncated?: boolean
		isError?: boolean
		spill?: boolean
	}[],
	options: {
		readonly extra?: readonly Record<string, unknown>[]
		readonly open?: boolean
		readonly now?: () => number
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-tool-evidence-'))
	roots.push(root)
	const session = await evidenceSession(root, options.now ? { now: options.now } : {})
	for (const [index, output] of outputs.entries()) {
		const toolUseId = `call-${index}`
		const retained = output.spill
			? applyToolOutputBudget({
					toolUseId,
					toolName: 'observe',
					output: output.text,
					maxChars: 1000,
					spillDir: session.spillDir,
				})
			: null
		await session.append({
			type: 'tool_completed',
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
	for (const record of options.extra ?? []) await session.append(record)
	if (!options.open) await session.close()
	const base = { scope: session.scope, logPath: session.logPath }
	return {
		...base,
		session,
		source: createSessionEvidenceSource(base),
		reopen: () => createSessionEvidenceSource(base),
	}
}

/** The first tool output's seq: after `session_started` and `turn_started`. */
const FIRST = 3

describe('bounded retained tool evidence', () => {
	it.each(['tool', 'text'] as const)(
		'branches a strict token subset at the authenticated %s cursor, preserving the broad scan',
		async (kind) => {
			const f = await fixture([
				...Array.from({ length: 20 }, (_, i) => ({ text: `Atlas regional check ${i}` })),
				...Array.from({ length: 8 }, (_, i) => ({ text: `Borealis TRACK_${i}` })),
			])
			const make = () => (kind === 'tool' ? f.reopen() : createSessionTextEvidenceSource(f))
			const options = {
				terms: ['Atlas', 'Borealis'],
				matchMode: 'token' as const,
				caseSensitive: false,
				excludeSuccessfulTools: ['search'],
			}
			const first = await make().search(options)
			if (!first.nextCursor) throw new Error('Missing broad cursor.')
			expect(first.matches).toHaveLength(4)
			const focused = await make().search({
				...options,
				cursor: first.nextCursor,
				refineTerms: ['borealis'],
				maxReadBytes: 1024 * 1024,
			})
			expect(focused.scannedBytes).toBeLessThanOrEqual(1024 * 1024)
			expect(focused.matches.map((m) => m.excerpt)).toEqual(
				Array.from({ length: 4 }, (_, i) => `Borealis TRACK_${i}`),
			)
			if (!focused.nextCursor) throw new Error('Missing focused cursor.')
			const remainder = await make().search({
				...options,
				terms: ['borealis'],
				cursor: focused.nextCursor,
			})
			expect(remainder.matches.map((m) => m.excerpt)).toEqual(
				Array.from({ length: 4 }, (_, i) => `Borealis TRACK_${i + 4}`),
			)
			const broad = await make().search({ ...options, cursor: first.nextCursor })
			expect(broad.matches[0]?.excerpt).toBe('Atlas regional check 4')
			for (const refineTerms of [[], ['Foreign'], ['Atlas', 'Borealis'], ['two words']])
				await expect(
					make().search({ ...options, cursor: first.nextCursor, refineTerms }),
				).rejects.toThrow()
			await expect(make().search({ ...options, refineTerms: ['Borealis'] })).rejects.toThrow(
				'cursor',
			)
			await expect(make().search({ ...options, cursor: focused.nextCursor })).rejects.toThrow(
				'query changed',
			)
			await expect(
				make().search({
					...options,
					cursor: first.nextCursor,
					excludeSuccessfulTools: [],
					refineTerms: ['Borealis'],
				}),
			).rejects.toThrow('query changed')
			await expect(
				make().search(
					{ ...options, cursor: first.nextCursor, refineTerms: ['Borealis'] },
					AbortSignal.abort(new Error('cancelled')),
				),
			).rejects.toThrow('cancelled')
		},
	)

	it.each(['tool', 'text'] as const)(
		'accepts a smaller per-operation budget without changing %s addresses or the source ceiling',
		async (mode) => {
			const mib = 1024 * 1024
			const f = await fixture([{ text: `DELTA ${'ordinary '.repeat(150_000)}` }])
			const make = (maxReadBytes?: number) =>
				mode === 'tool'
					? createSessionEvidenceSource({ ...f, maxReadBytes })
					: createSessionTextEvidenceSource({ ...f, maxReadBytes })
			const source = make()
			const full = await source.search({ query: 'DELTA' })
			const match = full.matches[0]!
			expect(match.excerpt).toContain('DELTA')
			for (const [reader, maxReadBytes] of [
				[source, mib],
				[make(mib), 8 * mib],
			] as const) {
				const partial = await reader.search({ query: 'DELTA', maxReadBytes })
				expect(partial.scannedBytes).toBeLessThanOrEqual(mib)
				expect(partial.matches).toEqual([])
				expect(partial.nextCursor).not.toBeNull()
				await expect(reader.read({ address: match.address, maxReadBytes })).rejects.toThrow()
				const resumed = await make().search({
					query: 'DELTA',
					cursor: partial.nextCursor!,
					maxReadBytes: 8 * mib,
				})
				expect(resumed.matches[0]?.address).toBe(match.address)
			}
			expect((await source.read({ address: match.address })).text).toContain('DELTA')
			for (const maxReadBytes of [0, mib - 1, mib + 0.5, Number.NaN, 8 * mib + 1]) {
				await expect(source.search({ maxReadBytes })).rejects.toThrow()
				await expect(source.read({ address: match.address, maxReadBytes })).rejects.toThrow()
			}
		},
	)

	it.each(['tool', 'text', 'snapshot'] as const)(
		'proves whole text-part coverage from UTF-8 bounds, not excerpt length (%s)',
		async (mode) => {
			const short = 'ORCHID 🦉 İzmir'
			const exact = `ORCHID ${'ç'.repeat(505)}`
			const f = await fixture(
				[
					{ text: short },
					{ text: exact },
					{ text: `${exact}x` },
					{ text: `${'padding '.repeat(1000)}ORCHID 🦉`, spill: true },
					{ text: short, truncated: true },
				],
				{ open: mode === 'snapshot' },
			)
			for (let reopen = 0; reopen < 2; reopen++) {
				const source =
					mode === 'tool'
						? f.reopen()
						: createSessionTextEvidenceSource({
								...f,
								...(mode === 'snapshot' ? { consistency: 'snapshot' as const } : {}),
							})
				const first = await source.search({ query: 'ORCHID' })
				const next = await source.search({ query: 'ORCHID', cursor: first.nextCursor! })
				const result = { ...next, matches: [...first.matches, ...next.matches] }
				expect(result.matches.map((m) => m.excerptComplete)).toEqual([
					true,
					true,
					false,
					false,
					false,
				])
				expect(result.matches[0]?.excerpt).toBe(short)
				expect(result.matches[1]?.excerpt).toBe(exact)
				expect(result.matches[3]?.excerpt.length).toBeLessThan(512)
				expect(result.matches[3]?.byteOffset).toBeGreaterThan(0)
				expect(result.incomplete).toBe(true) // The retained preview prevents an exhaustive claim.
			}
		},
	)

	it('reads a snapshot of a running turn without closing or rewriting its log', async () => {
		const original = `${'background '.repeat(10000)}ORCHID original 🦉`
		const f = await fixture([{ text: original, spill: true }], { open: true })
		const log = await readFile(f.logPath)
		await expect(f.source.search()).rejects.toThrow('not closed')
		const source = createSessionTextEvidenceSource({ ...f, consistency: 'snapshot' })
		const result = await source.search({ query: 'ORCHID' })
		expect(result.matches).toHaveLength(1)
		expect(result.incomplete).toBe(true)
		expect(result.unavailable).toEqual([])
		expect(result.nextCursor).toBeNull()
		const match = result.matches[0]!
		const read = await source.read({ address: match.address, byteOffset: match.byteOffset })
		expect(read.text).toContain('ORCHID original 🦉')
		expect(read.retained).toBe('full')
		expect(read.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
		expect(await readFile(f.logPath)).toEqual(log)
		expect(await f.session.log.activeTurn()).not.toBeNull()
		await expect(source.search({}, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow(
			'cancelled',
		)
		await expect(
			source.read({ address: match.address }, AbortSignal.abort(new Error('cancelled'))),
		).rejects.toThrow('cancelled')
	})

	it('keeps snapshot addresses bound to their source version, consistency mode and owner', async () => {
		const f = await fixture([{ text: 'ORCHID exact original', spill: true }], { open: true })
		const snapshot = createSessionTextEvidenceSource({ ...f, consistency: 'snapshot' })
		const closed = createSessionTextEvidenceSource(f)
		const match = (await snapshot.search({ query: 'ORCHID' })).matches[0]!
		await expect(closed.read({ address: match.address })).rejects.toThrow()
		expect((await snapshot.read({ address: match.address })).text).toBe('ORCHID exact original')
		await writeFile(
			f.logPath,
			(await readFile(f.logPath, 'utf8')).replace('exact original', 'newer original'),
		)
		await expect(snapshot.read({ address: match.address })).rejects.toThrow()
		const next = (await snapshot.search({ query: 'ORCHID' })).matches[0]!
		expect((await snapshot.read({ address: next.address })).text).toBe('ORCHID newer original')
		// The log now names another session: it is not this scope's evidence.
		await writeFile(
			f.logPath,
			(await readFile(f.logPath, 'utf8')).replaceAll(f.scope.sessionId, randomUUID()),
		)
		await expect(snapshot.search()).rejects.toThrow('authorized scope')
		await expect(snapshot.read({ address: next.address })).rejects.toThrow('authorized scope')
	})

	it('refuses changed authenticated output in a snapshot', async () => {
		const f = await fixture([{ text: `${'background '.repeat(1000)}ORCHID`, spill: true }], {
			open: true,
		})
		const snapshot = createSessionTextEvidenceSource({ ...f, consistency: 'snapshot' })
		const match = (await snapshot.search({ query: 'ORCHID' })).matches[0]!
		const files = await readdir(f.session.spillDir)
		const output = files.find((name) => !name.endsWith('.json'))!
		await writeFile(join(f.session.spillDir, output), 'changed original')
		await expect(snapshot.read({ address: match.address })).rejects.toThrow()
		const changed = await snapshot.search({ query: 'ORCHID' })
		expect(changed.matches).toEqual([])
		expect(changed.unavailable).toHaveLength(1)
	})

	it('recovers complete records before an interrupted final append without repairing the file', async () => {
		const f = await fixture(
			[{ text: `${'background '.repeat(1000)}ORCHID exact 🦉`, spill: true }],
			{
				open: true,
			},
		)
		const raw = `${await readFile(f.logPath, 'utf8')}{"type":"message_completed","content":"unfinished`
		await writeFile(f.logPath, raw)
		const source = createSessionTextEvidenceSource({ ...f, consistency: 'snapshot' })
		const page = await source.search({ query: 'ORCHID' })
		expect(page.matches).toHaveLength(1)
		expect(page.incomplete).toBe(true)
		expect(page.unavailable).toEqual([])
		expect(page.nextCursor).toBeNull()
		const match = page.matches[0]!
		const exact = await source.read({ address: match.address, byteOffset: match.byteOffset })
		expect(exact.text).toContain('ORCHID exact 🦉')
		expect(exact.retained).toBe('full')
		expect(exact.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
		expect((await source.search({ query: 'unfinished' })).matches).toEqual([])
		expect(await readFile(f.logPath, 'utf8')).toBe(raw)
		// A reader that demands a closed scope reads the whole file, torn tail
		// included, and refuses it.
		await expect(createSessionTextEvidenceSource(f).search()).rejects.toThrow()
	})

	it.each([20, 4 * 1024 * 1024])(
		'refuses an uncommitted tail without a bounded complete prefix (%i)',
		async (size) => {
			const f = await fixture([], { open: true })
			const raw = `${size > 20 ? await readFile(f.logPath, 'utf8') : ''}${'x'.repeat(size)}`
			await writeFile(f.logPath, raw)
			await expect(
				createSessionTextEvidenceSource({ ...f, consistency: 'snapshot' }).search(),
			).rejects.toThrow(/complete recorded evidence|bounded record size/)
			expect(await readFile(f.logPath, 'utf8')).toBe(raw)
		},
	)

	it('crosses many compacted messages without rereading the shared record for every part', async () => {
		const messages = Array.from({ length: 128 }, (_, part) => ({
			role: 'user',
			content: `${'ordinary '.repeat(900)} ${part === 127 ? 'ORCHID-PAGE-RECEIPT' : ''}`,
		}))
		const f = await fixture([], {
			extra: [{ type: 'compaction_shed', iteration: 1, reason: 'threshold', messages }],
		})
		for (const _phase of ['cold', 'warm']) {
			const source = createSessionTextEvidenceSource(f)
			let cursor: string | undefined
			let bytes = 0
			const matches = []
			// Two pages for the shed record's 128 parts, and one for the turn's end.
			for (let page = 0; page < 3; page++) {
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
			expect(matches[0]).toMatchObject({ seq: FIRST, part: 127 })
			const read = await source.read({
				address: matches[0]!.address,
				byteOffset: matches[0]!.byteOffset,
			})
			expect(read.text).toContain('ORCHID-PAGE-RECEIPT')
		}
	})

	it.each([false, true])(
		'recovers the recorded time through search and exact reads (spill=%s)',
		async (spill) => {
			const recordedAt = Date.UTC(2025, 0, 2, 3, 4, 5)
			const f = await fixture(
				[{ text: `${spill ? 'padding '.repeat(1000) : ''}DELTA receipt`, spill }],
				{ now: () => recordedAt },
			)
			for (const source of [f.source, f.reopen()]) {
				const page = await source.search({ query: 'DELTA' })
				expect(page.matches[0]?.recordedAt).toBe(recordedAt)
				expect((await source.read({ address: page.matches[0]!.address })).recordedAt).toBe(
					recordedAt,
				)
			}
		},
	)

	it('dates a compaction copy by its own record without inventing an original message date', async () => {
		const recordedAt = Date.UTC(2026, 0, 1)
		const f = await fixture([], {
			now: () => recordedAt,
			extra: [
				{
					type: 'compaction_shed',
					iteration: 1,
					reason: 'threshold',
					messages: [{ role: 'tool', content: 'DELTA receipt from 2020', timestamp: 1 }],
				},
			],
		})
		const source = createSessionTextEvidenceSource(f)
		const match = (await source.search({ query: 'DELTA' })).matches[0]!
		expect(match.source).toBe('compaction_shed:tool')
		expect(match.recordedAt).toBe(recordedAt)
		expect((await source.read({ address: match.address })).recordedAt).toBe(recordedAt)
	})

	it('indexes assistant output and more than one page of shed parts without losing identity', async () => {
		const f = await fixture([{ text: 'shared tool result' }], {
			extra: [
				{ type: 'message_completed', content: 'shared assistant 🦉' },
				{
					type: 'compaction_shed',
					iteration: 1,
					reason: 'threshold',
					messages: [
						{ role: 'assistant', content: [{ type: 'image' }] },
						...Array.from({ length: 130 }, (_, part) => ({
							role: 'user',
							content: `shared shed ${part}`,
						})),
					],
				},
			],
		})
		let cursor: string | null = null
		const matches = []
		let calls = 0
		do {
			const page: SessionTextEvidenceSearchResult = await createSessionTextEvidenceSource(f).search(
				{
					query: 'shared',
					cursor: cursor ?? undefined,
				},
			)
			expect(page.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
			matches.push(...page.matches)
			cursor = page.nextCursor
			expect(++calls).toBeLessThan(50)
		} while (cursor)
		expect(matches.map((m) => [m.seq, m.part])).toEqual([
			[FIRST, 0],
			[FIRST + 1, 0],
			...Array.from({ length: 130 }, (_, part) => [FIRST + 2, part]),
		])
		const source = createSessionTextEvidenceSource(f)
		const read = await source.read({ address: matches[1]!.address })
		expect(read).toMatchObject({
			text: 'shared assistant 🦉',
			source: 'message_completed',
			part: 0,
			characterOffset: 0,
			totalChars: 19,
		})
		const tools = await f.source.search({ query: 'shared' })
		expect(tools.matches.map((m) => m.seq)).toEqual([FIRST])
		await expect(f.source.read({ address: matches[1]!.address })).rejects.toThrow()
		let located = await source.search({ seq: FIRST + 2, part: 129 })
		while (located.nextCursor && !located.matches.length)
			located = await source.search({ seq: FIRST + 2, part: 129, cursor: located.nextCursor })
		expect(located.matches[0]?.excerpt).toBe('shared shed 129')
		await expect(
			source.search({ seq: FIRST + 2, part: 128, cursor: tools.nextCursor! }),
		).rejects.toThrow()
	})

	it('maps byte offsets back to exact UTF-16 positions across Unicode chunk boundaries', async () => {
		const prefix = '﻿' + 'α🦉\r\n'.repeat(30_000)
		const full = prefix + 'UNIQUE-RECEIPT' + 'β'.repeat(40_000)
		const f = await fixture([{ text: full, spill: true }])
		const source = createSessionTextEvidenceSource(f)
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

	it('pages across reopening without collapsing equal tool results', async () => {
		const f = await fixture(
			Array.from({ length: 75 }, (_, i) => ({
				text: i > 63 ? 'late evidence' : 'same early evidence',
			})),
		)
		const first = await f.source.search({ query: 'late evidence' })
		expect(first.matches).toHaveLength(0)
		expect(first.nextCursor).not.toBeNull()
		expect(first.indexedRecords).toBe(64)
		const found: number[] = []
		let cursor = first.nextCursor
		while (cursor) {
			const page: SessionEvidenceSearchResult = await f
				.reopen()
				.search({ query: 'late evidence', cursor })
			found.push(...page.matches.map((match) => match.seq))
			cursor = page.nextCursor
		}
		expect(found).toEqual(Array.from({ length: 11 }, (_, i) => FIRST + 64 + i))
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
		const full = '﻿' + 'α🦉\r\n﻿\0'.repeat(12_000)
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
		const spill = join(f.session.spillDir, `${digest('call-0')}.txt`)
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

	it('distinguishes partial text and error output, including a negative query', async () => {
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

	it('binds addresses to the authorized session and refuses running or changed sources', async () => {
		const a = await fixture([{ text: 'private result' }])
		const b = await fixture([{ text: 'other result' }], { open: true })
		const address = (await a.source.search()).matches[0]!.address
		const bClosedView = createSessionEvidenceSource({ ...b, consistency: 'snapshot' })
		await expect(bClosedView.read({ address })).rejects.toThrow('different scope')
		await expect(createSessionEvidenceSource({ ...a, scope: b.scope }).search()).rejects.toThrow(
			'authorized scope',
		)
		await expect(b.source.search()).rejects.toThrow('not closed')
		await writeFile(a.logPath, 'changed\n')
		await expect(a.source.read({ address })).rejects.toThrow()
	})

	it('refuses altered cursors, symlinks, torn records and cancellation', async () => {
		const f = await fixture(Array.from({ length: 70 }, () => ({ text: 'ordinary' })))
		const cursor = (await f.source.search({ query: 'absent' })).nextCursor!
		await expect(f.reopen().search({ query: 'changed', cursor })).rejects.toThrow('query changed')
		await expect(f.reopen().search({ query: 'absent', cursor: `x${cursor}` })).rejects.toThrow()
		await expect(f.source.search({}, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow(
			'cancelled',
		)
		await writeFile(f.logPath, '{"type":"session_started"')
		await expect(f.source.search()).rejects.toThrow()
		await rm(f.logPath)
		await symlink(f.session.spillDir, f.logPath)
		await expect(f.source.search()).rejects.toThrow()
	})
})
