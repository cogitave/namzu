import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	SessionEvidenceOffsetError,
	type SessionId,
	type SessionTextEvidenceMatch,
	type SessionTextEvidenceReadResult,
	type SessionTextEvidenceSearchResult,
	type SessionTextEvidenceSource,
	type TurnId,
	generateTurnId,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'

/**
 * The host rules around the SDK's evidence reader: every page a source hands
 * back is checked before its text reaches the model or its address is cached,
 * and one call's paging, lookup and byte work stays bounded. The source here
 * is the live-turn seam (`captureSessionEvidence`), so each test controls
 * exactly what a page claims; the SDK reader itself is proved in
 * `packages/sdk/src/store/evidence/__tests__`.
 */

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		// The recall step is the kernel's; the adapter under test is `retrieve`.
		createEvidenceRecallStep: (options: unknown) => options,
		refineEvidenceRecallTerms: () => undefined,
	}
})

const { openSessions, startConversation } = await import('./store.js')
const {
	buildConversationReadTool,
	readConversationEvidence,
	releaseConversationEvidence,
	searchConversation,
} = await import('./conversation-search.js')
const { createConversationEvidenceRecall } = await import('./evidence-recall.js')

type Sessions = Awaited<ReturnType<typeof openSessions>>
type Search = SessionTextEvidenceSource['search']
type Read = SessionTextEvidenceSource['read']

const MiB = 1024 * 1024
const owners: { sessions: Sessions; sessionId: SessionId }[] = []
const roots: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const { sessions, sessionId } of owners.splice(0))
		await releaseConversationEvidence(sessions, sessionId)
	for (const root of roots.splice(0)) removeTempDir(root)
})

async function fixture(text = 'ORIGINAL') {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-evidence-boundary-'))
	const home = mkdtempSync(join(tmpdir(), 'namzu-evidence-boundary-home-'))
	roots.push(cwd, home)
	const sessions = await openSessions(cwd, { stateRoot: home })
	const sessionId = await startConversation(sessions)
	owners.push({ sessions, sessionId })
	const turnId = generateTurnId()
	const scope = { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId }
	const match: SessionTextEvidenceMatch = {
		address: 'owned-address',
		seq: 2,
		part: 0,
		source: 'tool_completed',
		toolName: 'read',
		isError: false,
		retained: 'full',
		excerpt: text,
		byteOffset: 0,
		characterOffset: 0,
	}
	const page = (
		nextCursor: string | null,
		extra: Partial<SessionTextEvidenceSearchResult> = {},
	): SessionTextEvidenceSearchResult => ({
		scope,
		matches: [],
		nextCursor,
		scannedBytes: 1024,
		indexedRecords: 0,
		cacheHit: true,
		incomplete: false,
		unavailable: [],
		...extra,
	})
	const searchPage = page(null, { matches: [match], scannedBytes: 100, indexedRecords: 1 })
	const readPage: SessionTextEvidenceReadResult = {
		scope,
		seq: 2,
		part: 0,
		source: 'tool_completed',
		toolName: 'read',
		isError: false,
		retained: 'full',
		text,
		byteOffset: 0,
		nextByteOffset: null,
		totalBytes: Buffer.byteLength(text),
		scannedBytes: 100,
	}
	const search = vi.fn<Search>().mockResolvedValue(searchPage)
	const read = vi.fn<Read>().mockResolvedValue(readPage)
	const captures: (number | undefined)[] = []
	const activeWith = (source: () => SessionTextEvidenceSource) => ({
		sessionId,
		turnId: turnId as TurnId,
		captureSessionEvidence: async (bytes?: number) => {
			captures.push(bytes)
			return source()
		},
	})
	const active = activeWith(() => ({ scope, search, read }))
	return {
		sessions,
		sessionId,
		turnId,
		scope,
		match,
		page,
		searchPage,
		readPage,
		search,
		read,
		captures,
		active,
		activeWith,
	}
}

describe('a search page is checked before its text or address is used', () => {
	it.each(['tenantId', 'projectId', 'sessionId'] as const)(
		'refuses a page with a foreign %s, and caches none of its addresses',
		async (field) => {
			const f = await fixture()
			f.search.mockResolvedValueOnce({
				...f.searchPage,
				scope: { ...f.scope, [field]: generateTurnId() },
				matches: [{ ...f.match, address: 'foreign-address', excerpt: 'FOREIGN_SECRET' }],
			})

			await expect(
				searchConversation(f.sessions, f.sessionId, { query: 'SECRET' }, undefined, f.active),
			).rejects.toThrow('different owner')

			// The foreign address was never cached: a read looks its record up again.
			const own = await readConversationEvidence(
				f.sessions,
				f.sessionId,
				{ seq: 2 },
				undefined,
				f.active,
			)
			expect(own.text).toBe('ORIGINAL')
			expect(f.search).toHaveBeenCalledTimes(2)
			expect(f.read.mock.calls[0]?.[0].address).toBe('owned-address')
		},
	)

	it('reads a search narrowed to one turn from the log, never from the capture', async () => {
		const f = await fixture()

		// The capture covers the whole session and cannot be narrowed; the
		// conversation's own log, read under the turn's scope, has no such turn.
		const narrowed = await searchConversation(
			f.sessions,
			f.sessionId,
			{ turnId: f.turnId, query: 'ORIGINAL' },
			undefined,
			f.active,
		)

		expect(f.captures).toEqual([])
		expect(f.search).not.toHaveBeenCalled()
		expect(narrowed.matches).toEqual([])
	})

	it.each([
		'negative-bytes',
		'nonfinite-bytes',
		'excess-bytes',
		'too-many-matches',
		'oversized-excerpt',
		'oversized-cursor',
		'unavailable-but-complete',
		'preview-claimed-complete',
		'offset-claimed-complete',
	] as const)('refuses a malformed search page (%s)', async (variant) => {
		const f = await fixture()
		const page: { -readonly [K in keyof SessionTextEvidenceSearchResult]: unknown } = {
			...f.searchPage,
		}
		if (variant === 'negative-bytes') page.scannedBytes = -1
		if (variant === 'nonfinite-bytes') page.scannedBytes = Number.NaN
		if (variant === 'excess-bytes') page.scannedBytes = 9 * MiB
		if (variant === 'too-many-matches') page.matches = Array(4).fill(f.match)
		if (variant === 'oversized-excerpt') page.matches = [{ ...f.match, excerpt: 'x'.repeat(513) }]
		if (variant === 'oversized-cursor') page.nextCursor = 'x'.repeat(4097)
		if (variant === 'unavailable-but-complete') page.unavailable = ['Missing original']
		if (variant === 'preview-claimed-complete')
			page.matches = [{ ...f.match, retained: 'preview', excerptComplete: true }]
		if (variant === 'offset-claimed-complete')
			page.matches = [{ ...f.match, byteOffset: 1, excerptComplete: true }]
		f.search.mockResolvedValue(page as SessionTextEvidenceSearchResult)

		await expect(
			searchConversation(f.sessions, f.sessionId, { query: 'ORIGINAL' }, undefined, f.active),
		).rejects.toThrow(/retrieval bounds|invalid metadata/)
		expect(f.search).toHaveBeenCalledOnce()
	})

	it('validates the whole match batch before caching even its first valid address', async () => {
		const f = await fixture()
		f.search.mockResolvedValueOnce({
			...f.searchPage,
			matches: [f.match, { ...f.match, part: -1 }],
		})

		await expect(
			searchConversation(f.sessions, f.sessionId, { query: 'ORIGINAL' }, undefined, f.active),
		).rejects.toThrow('invalid metadata')
		await readConversationEvidence(f.sessions, f.sessionId, { seq: 2 }, undefined, f.active)

		expect(f.search).toHaveBeenCalledTimes(2)
	})

	it('holds automatic recall to the same page checks before any candidate is prepared', async () => {
		const f = await fixture()
		f.search.mockResolvedValue({
			...f.searchPage,
			matches: [{ ...f.match, excerpt: 'x'.repeat(513) }],
		})
		const recall = createConversationEvidenceRecall(
			f.sessions,
			f.sessionId,
			() => {},
		) as unknown as {
			retrieve: (request: object) => Promise<unknown>
		}

		await expect(
			recall.retrieve({
				turnId: f.turnId,
				captureSessionEvidence: f.active.captureSessionEvidence,
				terms: ['ORIGINAL'],
				maxReadBytes: 8 * MiB,
				maxCandidates: 24,
				signal: new AbortController().signal,
			}),
		).rejects.toThrow('retrieval bounds')
		expect(f.search).toHaveBeenCalledOnce()
	})
})

describe('a read page is checked before its text is returned', () => {
	it.each(['tenantId', 'projectId', 'sessionId'] as const)(
		'refuses a page with a foreign %s',
		async (field) => {
			const f = await fixture()
			f.read.mockResolvedValue({
				...f.readPage,
				scope: { ...f.scope, [field]: generateTurnId() },
				text: 'FOREIGN!',
			})

			await expect(
				readConversationEvidence(f.sessions, f.sessionId, { seq: 2 }, undefined, f.active),
			).rejects.toThrow('different owner')
		},
	)

	it.each(['foreign-scope', 'wrong-seq', 'wrong-part', 'excess-bytes'] as const)(
		'refuses an invalid address lookup before reading anything (%s)',
		async (variant) => {
			const f = await fixture()
			const page = { ...f.searchPage }
			if (variant === 'foreign-scope') page.scope = { ...f.scope, sessionId: generateTurnId() }
			if (variant === 'wrong-seq') page.matches = [{ ...f.match, seq: 3 }]
			if (variant === 'wrong-part') page.matches = [{ ...f.match, part: 1 }]
			if (variant === 'excess-bytes') page.scannedBytes = 9 * MiB
			f.search.mockResolvedValueOnce(page)

			await expect(
				readConversationEvidence(f.sessions, f.sessionId, { seq: 2 }, undefined, f.active),
			).rejects.toThrow()
			expect(f.read).not.toHaveBeenCalled()
		},
	)

	it.each([
		'negative-bytes',
		'excess-bytes',
		'oversized-text',
		'wrong-offset',
		'wrong-next',
		'short-total',
	] as const)('refuses an inconsistent read page (%s)', async (variant) => {
		const f = await fixture()
		const page: { -readonly [K in keyof SessionTextEvidenceReadResult]: unknown } = {
			...f.readPage,
		}
		if (variant === 'negative-bytes') page.scannedBytes = -1
		if (variant === 'excess-bytes') page.scannedBytes = 8 * MiB
		if (variant === 'oversized-text') {
			page.text = 'x'.repeat(6001)
			page.totalBytes = 6001
		}
		if (variant === 'wrong-offset') page.byteOffset = 1
		if (variant === 'wrong-next') {
			page.nextByteOffset = 1
			page.totalBytes = 10
		}
		if (variant === 'short-total') page.totalBytes = 2
		f.read.mockResolvedValue(page as SessionTextEvidenceReadResult)

		await expect(
			readConversationEvidence(f.sessions, f.sessionId, { seq: 2 }, undefined, f.active),
		).rejects.toThrow()
	})

	it('honours cancellation even when the reader ignores it and returns a valid page', async () => {
		const f = await fixture()
		const controller = new AbortController()
		f.read.mockImplementation(async () => {
			controller.abort(new Error('Cancelled evidence read'))
			return f.readPage
		})

		await expect(
			readConversationEvidence(f.sessions, f.sessionId, { seq: 2 }, controller.signal, f.active),
		).rejects.toThrow('Cancelled evidence read')
	})

	it('keeps exact Unicode and leaves an unknown character count unknown', async () => {
		const f = await fixture('İ🦉')

		const page = await readConversationEvidence(
			f.sessions,
			f.sessionId,
			{ seq: 2 },
			undefined,
			f.active,
		)

		expect(page.text).toBe('İ🦉')
		expect(page.totalChars).toBeUndefined()
		expect(page.complete).toBe(true)
		expect(page.scannedBytes).toBe(200)
	})
})

describe('a read that cannot continue as asked says what to do next', () => {
	const toolFor = (f: Awaited<ReturnType<typeof fixture>>) =>
		buildConversationReadTool(() => ({ sessions: f.sessions, sessionId: f.sessionId }))
	const contextFor = (f: Awaited<ReturnType<typeof fixture>>) =>
		({
			abortSignal: new AbortController().signal,
			sessionId: f.sessionId,
			turnId: f.turnId,
			captureSessionEvidence: async () => ({ scope: f.scope, search: f.search, read: f.read }),
		}) as never

	it('reads from zero, and says the offset was ignored, when the record has no character index', async () => {
		const f = await fixture('0123456789')
		f.read.mockImplementation(async (options) =>
			options.byteOffset
				? { ...f.readPage, text: '56789', byteOffset: options.byteOffset }
				: { ...f.readPage, characterOffset: undefined },
		)

		const page = await readConversationEvidence(
			f.sessions,
			f.sessionId,
			{ seq: 2, byteOffset: 5 },
			undefined,
			f.active,
		)

		expect(page.text).toBe('0123456789')
		expect(page.note).toMatch(/no character index.*byteOffset 5 was ignored/)
		expect(f.read.mock.calls.map(([options]) => options.byteOffset)).toEqual([5, 0])
	})

	it('keeps a page whose offset has a character index free of notes', async () => {
		const f = await fixture('0123456789')
		f.read.mockImplementation(async (options) => ({
			...f.readPage,
			text: '56789',
			byteOffset: options.byteOffset ?? 0,
			characterOffset: 5,
		}))

		const page = await readConversationEvidence(
			f.sessions,
			f.sessionId,
			{ seq: 2, byteOffset: 5 },
			undefined,
			f.active,
		)

		expect(page).toMatchObject({ text: '56789', offset: 5 })
		expect(page.note).toBeUndefined()
	})

	it('tells the model to search again when the retained text changed', async () => {
		const f = await fixture()
		f.search.mockResolvedValueOnce({
			...f.searchPage,
			matches: [],
			unavailable: ['x'],
			incomplete: true,
		})

		const result = await toolFor(f).execute({ seq: 2 }, contextFor(f))

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/unavailable or changed.*search_conversation again/)
	})

	it('tells the model to search again when the address now holds another record', async () => {
		const f = await fixture()
		f.read.mockResolvedValue({ ...f.readPage, seq: 3 })

		const result = await toolFor(f).execute({ seq: 2 }, contextFor(f))

		expect(result.success).toBe(false)
		expect(result.error).toMatch(
			/no longer matches the requested seq and part.*search_conversation/,
		)
	})

	it('names the failure only generically when an ownership or integrity check refuses', async () => {
		const f = await fixture()
		f.read.mockResolvedValue({
			...f.readPage,
			scope: { ...f.scope, sessionId: generateTurnId() },
			text: 'FOREIGN!',
		})

		const result = await toolFor(f).execute({ seq: 2 }, contextFor(f))

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/could not be read or verified.*search_conversation again/)
		expect(result.error).not.toMatch(/owner|FOREIGN/)
	})

	it('recovers only from the reader\u2019s own offset answer, never from an integrity refusal', async () => {
		const f = await fixture('0123456789')
		const log = vi.fn()
		f.read.mockRejectedValue(new Error('Recorded tool evidence changed.'))
		const context = { ...(contextFor(f) as object), log } as never

		const result = await toolFor(f).execute({ seq: 2, byteOffset: 5 }, context)

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/could not be read or verified/)
		expect(result.error).not.toMatch(/Recorded tool evidence/)
		expect(f.read).toHaveBeenCalledTimes(1)
		expect(log).toHaveBeenCalledWith(
			'warn',
			expect.stringContaining('Recorded tool evidence changed'),
		)
	})

	it('charges every probe of a snapped read once', async () => {
		const f = await fixture('0123456789')
		f.read.mockImplementation(async (options) => {
			if (options.byteOffset === 5)
				throw new SessionEvidenceOffsetError('inside_character', 'splits', 10, 40)
			return {
				...f.readPage,
				text: '456789',
				byteOffset: options.byteOffset ?? 0,
				characterOffset: 4,
				scannedBytes: 100,
			}
		})

		const page = await readConversationEvidence(
			f.sessions,
			f.sessionId,
			{ seq: 2, byteOffset: 5 },
			undefined,
			f.active,
		)

		expect(f.read.mock.calls.map(([options]) => options.byteOffset)).toEqual([5, 4])
		// The lookup search costs 100, the refused probe 40, the kept read 100.
		expect(page.scannedBytes).toBe(240)
	})

	it('charges a past-end answer once, not twice', async () => {
		const f = await fixture('0123456789')
		f.read.mockImplementation(async (options) => {
			if (options.byteOffset === 50)
				throw new SessionEvidenceOffsetError('past_end', 'past', 10, 30)
			return { ...f.readPage, byteOffset: options.byteOffset ?? 0, scannedBytes: 100 }
		})

		const page = await readConversationEvidence(
			f.sessions,
			f.sessionId,
			{ seq: 2, byteOffset: 50 },
			undefined,
			f.active,
		)

		expect(page).toMatchObject({ text: '', complete: true, scannedBytes: 230 })
		expect(page.note).toMatch(/past the end of this record \(10 bytes\)/)
	})

	it('says earlier pages repeat when an expired cursor restarts a read', async () => {
		const f = await fixture('0123456789')
		const page = await readConversationEvidence(
			f.sessions,
			f.sessionId,
			{ seq: 2, cursor: 'f'.repeat(48) },
			undefined,
			f.active,
		)

		expect(page.note).toMatch(/expired.*earlier pages repeats.*nextCursor continues/)
	})

	it('names the highest retained seq for a seq far past the end on the live backend too', async () => {
		const f = await fixture('0123456789')
		f.search.mockResolvedValue(f.page(null))

		const result = await toolFor(f).execute({ seq: 99999 }, contextFor(f))

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/seq 99999 is past the end.*highest retained seq is \d+/)
	})

	it('names a vanished saved output instead of a generic failure', async () => {
		const f = await fixture()
		f.read.mockRejectedValue(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }))

		const result = await toolFor(f).execute({ seq: 2 }, contextFor(f))

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/seq 2 part 0 is no longer on disk.*deleted or pruned/)
		expect(result.error).not.toMatch(/ENOENT/)
	})

	it('logs the real cause when a later page fails, and tells the model only that it changed', async () => {
		const f = await fixture()
		const log = vi.fn()
		f.read.mockImplementationOnce(async () => ({
			...f.readPage,
			text: 'first',
			nextByteOffset: 5,
			totalBytes: 10,
		}))
		const first = await toolFor(f).execute({ seq: 2 }, {
			...(contextFor(f) as object),
			log,
		} as never)
		f.read.mockRejectedValue(new Error('Retained output bytes changed.'))

		const result = await toolFor(f).execute(
			{ seq: 2, cursor: JSON.parse(first.output).nextCursor },
			{ ...(contextFor(f) as object), log } as never,
		)

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/changed since the previous page/)
		expect(result.error).not.toMatch(/bytes changed/)
		expect(log).toHaveBeenCalledWith(
			'warn',
			expect.stringContaining('Retained output bytes changed'),
		)
	})

	it('does not retry a later page of a read with another offset', async () => {
		const f = await fixture()
		f.read.mockImplementationOnce(async () => ({
			...f.readPage,
			text: 'first',
			nextByteOffset: 5,
			totalBytes: 10,
		}))
		const first = await readConversationEvidence(
			f.sessions,
			f.sessionId,
			{ seq: 2 },
			undefined,
			f.active,
		)
		f.read.mockRejectedValue(new Error('Retained output changed during read.'))

		await expect(
			readConversationEvidence(
				f.sessions,
				f.sessionId,
				{ seq: 2, cursor: first.nextCursor },
				undefined,
				f.active,
			),
		).rejects.toThrow(/changed since the previous page.*without a cursor/)
		expect(f.read).toHaveBeenCalledTimes(2)
	})
})

describe('one search call pages its source within bounds', () => {
	it('follows at most seven internal continuations, even over pages that cost nothing', async () => {
		const f = await fixture()
		let count = 0
		f.search.mockImplementation(async () => f.page(`next-${++count}`, { scannedBytes: 0 }))

		const result = await searchConversation(
			f.sessions,
			f.sessionId,
			{ query: 'TARGET' },
			undefined,
			f.active,
		)

		expect(f.search).toHaveBeenCalledTimes(8)
		expect(result.nextCursor).toBeDefined()
		expect(result.incomplete).toBe(true)
	})

	it('stops following a source that hands back the same cursor', async () => {
		const f = await fixture()
		f.search.mockImplementation(async () => f.page('unchanged'))

		const result = await searchConversation(
			f.sessions,
			f.sessionId,
			{ query: 'TARGET' },
			undefined,
			f.active,
		)

		expect(f.search).toHaveBeenCalledTimes(2)
		expect(result.nextCursor).toBeDefined()
	})

	it('stops before the remaining read allowance falls under 1 MiB, and hands back a cursor', async () => {
		const f = await fixture()
		let count = 0
		f.search.mockImplementation(async () => f.page(`next-${++count}`, { scannedBytes: 2.5 * MiB }))

		const result = await searchConversation(
			f.sessions,
			f.sessionId,
			{ query: 'TARGET' },
			undefined,
			f.active,
		)

		expect(f.search).toHaveBeenCalledTimes(3)
		expect(result.scannedBytes).toBe(7.5 * MiB)
		expect(result.nextCursor).toBeDefined()
		for (const [options] of f.search.mock.calls)
			expect(options?.maxReadBytes).toBeGreaterThanOrEqual(MiB)
	})

	it('passes cancellation between pages through, rather than returning part of the scan', async () => {
		const f = await fixture()
		const controller = new AbortController()
		f.search.mockImplementation(async () => {
			if (f.search.mock.calls.length === 2)
				controller.abort(new Error('Cancelled inside continuation'))
			return f.page(`next-${f.search.mock.calls.length}`)
		})

		await expect(
			searchConversation(f.sessions, f.sessionId, { query: 'TARGET' }, controller.signal, f.active),
		).rejects.toThrow('Cancelled inside continuation')
		expect(f.search).toHaveBeenCalledTimes(2)
	})

	it('drops the matches of earlier pages when a later page fails, and says the scan is incomplete', async () => {
		const f = await fixture()
		f.search.mockReset()
		f.search.mockResolvedValueOnce(
			f.page('next', { matches: [{ ...f.match, excerpt: 'TARGET before the source changed' }] }),
		)
		f.search.mockRejectedValueOnce(new Error('Source changed during internal continuation'))

		const result = await searchConversation(
			f.sessions,
			f.sessionId,
			{ query: 'TARGET' },
			undefined,
			f.active,
		)

		expect(result.matches).toEqual([])
		expect(result.incomplete).toBe(true)
		expect(result.nextCursor).toBeUndefined()
	})

	it('counts unavailable records across pages and stays incomplete at the end of the log', async () => {
		const f = await fixture()
		f.search.mockReset()
		f.search.mockResolvedValueOnce(
			f.page('next', { incomplete: true, unavailable: ['First missing original'] }),
		)
		f.search.mockResolvedValueOnce(
			f.page(null, { incomplete: true, unavailable: ['Second missing original'] }),
		)

		const result = await searchConversation(
			f.sessions,
			f.sessionId,
			{ query: 'TARGET' },
			undefined,
			f.active,
		)

		expect(result.unavailable).toBe(2)
		expect(result.incomplete).toBe(true)
		expect(result.nextCursor).toBeUndefined()
	})

	it('reserves escaped output before each page, and delivers every match exactly once', async () => {
		const f = await fixture()
		const all = Array.from({ length: 17 }, (_, i) => ({
			...f.match,
			address: `address-${i}`,
			seq: i + 2,
			excerpt: `TARGET ${i} ${'\u0001"\\'.repeat(166)}`,
		}))
		f.search.mockImplementation(async (options) => {
			const start = options?.cursor ? Number(options.cursor) : 0
			const end = start + (options?.limit ?? 5)
			return f.page(end < all.length ? String(end) : null, { matches: all.slice(start, end) })
		})

		let cursor: string | undefined
		const delivered: number[] = []
		let pages = 0
		do {
			const page = await searchConversation(
				f.sessions,
				f.sessionId,
				cursor ? { cursor, limit: 20 } : { query: 'TARGET', limit: 20 },
				undefined,
				f.active,
			)
			expect(Buffer.byteLength(JSON.stringify(page.matches))).toBeLessThanOrEqual(12_000)
			delivered.push(...page.matches.map((match) => match.seq))
			cursor = page.nextCursor
			expect(++pages).toBeLessThan(10)
		} while (cursor)

		expect(pages).toBeGreaterThan(1)
		expect(delivered).toEqual(all.map((match) => match.seq))
	})
})

describe('reading an address that no search cached', () => {
	it('yields after eight empty lookup pages, then continues from its cursor', async () => {
		const f = await fixture()
		f.search.mockReset()
		for (let i = 1; i <= 8; i++) f.search.mockResolvedValueOnce(f.page(`lookup-${i}`))
		f.search.mockResolvedValueOnce(f.searchPage)

		const first = await readConversationEvidence(
			f.sessions,
			f.sessionId,
			{ seq: 2 },
			undefined,
			f.active,
		)

		expect(first).toMatchObject({ text: '', complete: false })
		expect(first.recordKind).toBeUndefined()
		expect(first.toolName).toBeUndefined()
		expect(first.nextCursor).toBeDefined()
		expect(f.read).not.toHaveBeenCalled()
		// The source is reopened, and its scope checked again, before every lookup page.
		expect(f.captures).toHaveLength(8)
		for (let i = 1; i < f.captures.length; i++)
			expect(f.captures[i]).toBeLessThan(f.captures[i - 1] as number)

		const second = await readConversationEvidence(
			f.sessions,
			f.sessionId,
			{ seq: 2, cursor: first.nextCursor },
			undefined,
			f.active,
		)

		expect(second).toMatchObject({ text: 'ORIGINAL', complete: true, recordKind: 'tool_result' })
		expect(f.search.mock.calls.at(-1)?.[0]?.cursor).toBe('lookup-8')
	})

	it('yields at once when a lookup page leaves too little of the byte ceiling to read', async () => {
		const f = await fixture()
		f.search.mockResolvedValueOnce(f.page('lookup-1', { scannedBytes: 2.5 * MiB }))

		const first = await readConversationEvidence(
			f.sessions,
			f.sessionId,
			{ seq: 2 },
			undefined,
			f.active,
		)

		expect(first.text).toBe('')
		expect(first.scannedBytes).toBe(2.5 * MiB)
		expect(first.nextCursor).toBeDefined()
		expect(f.search).toHaveBeenCalledOnce()
	})

	it('refuses a reopened source that now belongs to another conversation', async () => {
		const f = await fixture()
		const foreign = await startConversation(f.sessions)
		let opened = 0
		f.search.mockReset()
		f.search.mockResolvedValue(f.page('lookup-1'))
		const active = f.activeWith(() => ({
			scope: ++opened === 1 ? f.scope : { ...f.scope, sessionId: foreign },
			search: f.search,
			read: f.read,
		}))

		await expect(
			readConversationEvidence(f.sessions, f.sessionId, { seq: 2 }, undefined, active),
		).rejects.toThrow('different conversation')
		expect(opened).toBe(2)
		expect(f.read).not.toHaveBeenCalled()
	})
})

describe('cached addresses and read cursors', () => {
	it('continues a long read by cursor, and forgets the cursor when the conversation is released', async () => {
		const f = await fixture()
		const text = 'first half|second half'
		const [head, tail] = ['first half|', 'second half']
		f.read.mockImplementation(async (options) =>
			options.byteOffset
				? {
						...f.readPage,
						text: tail,
						byteOffset: options.byteOffset,
						nextByteOffset: null,
						totalBytes: text.length,
					}
				: { ...f.readPage, text: head, nextByteOffset: head.length, totalBytes: text.length },
		)

		const first = await readConversationEvidence(
			f.sessions,
			f.sessionId,
			{ seq: 2 },
			undefined,
			f.active,
		)
		expect(first).toMatchObject({ text: head, complete: false })
		const second = await readConversationEvidence(
			f.sessions,
			f.sessionId,
			{ seq: 2, cursor: first.nextCursor },
			undefined,
			f.active,
		)
		expect(first.text + second.text).toBe(text)
		expect(second.complete).toBe(true)

		await releaseConversationEvidence(f.sessions, f.sessionId)
		// A forgotten cursor is not a dead end: the read restarts from its address.
		const restarted = await readConversationEvidence(
			f.sessions,
			f.sessionId,
			{ seq: 2, cursor: first.nextCursor },
			undefined,
			f.active,
		)
		expect(restarted).toMatchObject({ text: head, complete: false })
		expect(restarted.note).toMatch(/cursor had expired/)
	})

	it('reads a searched address without looking it up, and looks it up again once it expires', async () => {
		const f = await fixture()
		await searchConversation(f.sessions, f.sessionId, { query: 'ORIGINAL' }, undefined, f.active)
		expect(f.search).toHaveBeenCalledOnce()

		await readConversationEvidence(f.sessions, f.sessionId, { seq: 2 }, undefined, f.active)
		expect(f.search).toHaveBeenCalledOnce()

		const now = Date.now()
		vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60_000 + 1)
		const expired = await readConversationEvidence(
			f.sessions,
			f.sessionId,
			{ seq: 2 },
			undefined,
			f.active,
		)
		expect(expired.text).toBe('ORIGINAL')
		expect(f.search).toHaveBeenCalledTimes(2)
	})

	it('never lends one conversation’s cached address to another', async () => {
		const f = await fixture()
		await searchConversation(f.sessions, f.sessionId, { query: 'ORIGINAL' }, undefined, f.active)
		const other = await startConversation(f.sessions)
		owners.push({ sessions: f.sessions, sessionId: other })

		// The other conversation's own log has no record 2; the cached address
		// belongs to this one and is not tried.
		await expect(
			readConversationEvidence(f.sessions, other, { seq: 2 }, undefined, f.active),
		).rejects.toThrow('no retained textual part')
		expect(f.read).not.toHaveBeenCalled()
	})

	it('evicts the oldest of more than 128 cached addresses, which a read then looks up again', async () => {
		const f = await fixture()
		const all = Array.from({ length: 130 }, (_, i) => ({
			...f.match,
			address: `address-${i}`,
			seq: i + 2,
			excerpt: `TARGET ${i}`,
		}))
		f.search.mockImplementation(async (options) => {
			if (options?.seq !== undefined)
				return f.page(null, { matches: all.filter((match) => match.seq === options.seq) })
			const start = options?.cursor ? Number(options.cursor) : 0
			const end = start + (options?.limit ?? 5)
			return f.page(end < all.length ? String(end) : null, { matches: all.slice(start, end) })
		})
		f.read.mockImplementation(async (options) => {
			const match = all.find((candidate) => candidate.address === options.address)
			if (!match) throw new Error('unknown address')
			const text = match.excerpt
			return { ...f.readPage, seq: match.seq, text, totalBytes: Buffer.byteLength(text) }
		})
		let cursor: string | undefined
		let found = 0
		do {
			const page = await searchConversation(
				f.sessions,
				f.sessionId,
				cursor ? { cursor, limit: 20 } : { query: 'TARGET', limit: 20 },
				undefined,
				f.active,
			)
			found += page.matches.length
			cursor = page.nextCursor
		} while (cursor)
		expect(found).toBe(130)
		const lookups = () => f.search.mock.calls.filter(([options]) => options?.seq !== undefined)

		const newest = await readConversationEvidence(
			f.sessions,
			f.sessionId,
			{ seq: 131 },
			undefined,
			f.active,
		)
		expect(newest.text).toBe('TARGET 129')
		expect(lookups()).toHaveLength(0)

		const oldest = await readConversationEvidence(
			f.sessions,
			f.sessionId,
			{ seq: 2 },
			undefined,
			f.active,
		)
		expect(oldest.text).toBe('TARGET 0')
		expect(lookups()).toHaveLength(1)
	})
})

describe('automatic recall over derived summaries', () => {
	it('spends its refinement page on source records, and keeps the summary it already found', async () => {
		const f = await fixture()
		const summary = { ...f.match, source: 'compaction_shed:summary', excerpt: 'ORCHID summary' }
		// The broad scan finds only a derived summary and has more to read; a
		// scan without summaries finds nothing.
		f.search.mockImplementation(async (options) => {
			if (options?.excludeDerivedSummaries) return f.page(null)
			return options?.cursor ? f.page('broad-1') : f.page('broad-1', { matches: [summary] })
		})
		const recall = createConversationEvidenceRecall(
			f.sessions,
			f.sessionId,
			() => {},
		) as unknown as {
			retrieve: (request: object) => Promise<{
				candidates: { source: string }[]
				continuations: { input: { cursor: string } }[]
			}>
		}

		const batch = await recall.retrieve({
			turnId: f.turnId,
			captureSessionEvidence: f.active.captureSessionEvidence,
			terms: ['ORCHID'],
			maxReadBytes: 8 * MiB,
			maxCandidates: 24,
			signal: new AbortController().signal,
		})

		expect(batch.candidates.map((candidate) => candidate.source)).toEqual([
			'compaction_shed:summary',
		])
		const focused = f.search.mock.calls.filter(([options]) => options?.excludeDerivedSummaries)
		expect(focused).toHaveLength(1)
		expect(focused[0]?.[0]?.cursor).toBeUndefined()
		// The broad scan's cursor survives the empty focused scan.
		expect(batch.continuations).toHaveLength(1)
	})
})
