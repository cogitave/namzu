import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type RunTextEvidenceReadResult,
	type RunTextEvidenceSearchResult,
	type RunTextEvidenceSource,
	generateRunId,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	readConversationEvidence,
	releaseConversationEvidence,
	searchConversation,
} from './conversation-search.js'
import { createConversationEvidenceRecall } from './evidence-recall.js'
import { type CliSessions, openSessions, startConversation } from './store.js'

const owners: {
	root: string
	sessions: CliSessions
	sessionId: Awaited<ReturnType<typeof startConversation>>
}[] = []
afterEach(async () => {
	for (const owner of owners.splice(0)) {
		await releaseConversationEvidence(owner.sessions, owner.sessionId)
		removeTempDir(owner.root)
	}
})

async function fixture(text = 'ORIGINAL') {
	const root = await mkdtemp(join(tmpdir(), 'namzu-evidence-boundary-'))
	const sessions = await openSessions(root)
	const sessionId = await startConversation(sessions)
	owners.push({ root, sessions, sessionId })
	const runId = generateRunId()
	const scope = { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId }
	const match = {
		address: 'owned-address',
		seq: 2,
		part: 0,
		source: 'tool_completed',
		toolName: 'read',
		isError: false,
		retained: 'full' as const,
		excerpt: text,
		byteOffset: 0,
		characterOffset: 0,
	}
	const searchPage: RunTextEvidenceSearchResult = {
		scope,
		matches: [match],
		nextCursor: null,
		scannedBytes: 100,
		indexedRecords: 1,
		cacheHit: true,
		incomplete: false,
		unavailable: [],
	}
	const readPage: RunTextEvidenceReadResult = {
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
	const search = vi.fn<RunTextEvidenceSource['search']>().mockResolvedValue(searchPage)
	const read = vi.fn<RunTextEvidenceSource['read']>().mockResolvedValue(readPage)
	const active = { runId, captureRunEvidence: async () => ({ scope, search, read }) }
	return { sessions, sessionId, runId, scope, match, searchPage, readPage, search, read, active }
}

it.each(['tenantId', 'projectId', 'sessionId', 'runId'] as const)(
	'rejects a search page with foreign %s before exposing text or caching its address',
	async (field) => {
		const f = await fixture()
		f.search.mockResolvedValueOnce({
			...f.searchPage,
			scope: { ...f.scope, [field]: generateRunId() },
			matches: [{ ...f.match, address: 'foreign-address', excerpt: 'FOREIGN_SECRET' }],
		})
		const result = await searchConversation(
			f.sessions,
			f.sessionId,
			{ runId: f.runId, query: 'SECRET' },
			undefined,
			f.active,
		)
		expect(result.matches).toEqual([])
		expect(result.incomplete).toBe(true)
		expect(result.unavailableRuns).toBe(1)
		expect(result.scannedBytes).toBe(8 * 1024 * 1024)
		expect(JSON.stringify(result)).not.toContain('FOREIGN')
		const own = await readConversationEvidence(
			f.sessions,
			f.sessionId,
			{ runId: f.runId, seq: 2 },
			undefined,
			f.active,
		)
		expect(own.text).toBe('ORIGINAL')
		expect(f.search).toHaveBeenCalledTimes(2)
		expect(f.read.mock.calls[0]![0].address).toBe('owned-address')
	},
)

it.each([
	'negative-bytes',
	'nonfinite-bytes',
	'excess-bytes',
	'too-many-matches',
	'oversized-excerpt',
	'oversized-cursor',
] as const)('rejects a malformed search response (%s)', async (variant) => {
	const f = await fixture()
	const page = { ...f.searchPage }
	if (variant === 'negative-bytes') page.scannedBytes = -1
	if (variant === 'nonfinite-bytes') page.scannedBytes = Number.NaN
	if (variant === 'excess-bytes') page.scannedBytes = 9 * 1024 * 1024
	if (variant === 'too-many-matches') page.matches = Array(4).fill(f.match)
	if (variant === 'oversized-excerpt') page.matches = [{ ...f.match, excerpt: 'x'.repeat(513) }]
	if (variant === 'oversized-cursor') page.nextCursor = 'x'.repeat(4097)
	f.search.mockResolvedValue(page)
	const result = await searchConversation(
		f.sessions,
		f.sessionId,
		{ runId: f.runId, query: 'ORIGINAL' },
		undefined,
		f.active,
	)
	expect(result.matches).toEqual([])
	expect(result.incomplete).toBe(true)
	expect(result.unavailableRuns).toBe(1)
	expect(f.search).toHaveBeenCalledOnce()
})

it.each(['tenantId', 'projectId', 'sessionId', 'runId'] as const)(
	'rejects a read page with foreign %s',
	async (field) => {
		const f = await fixture()
		f.read.mockResolvedValue({
			...f.readPage,
			scope: { ...f.scope, [field]: generateRunId() },
			text: 'FOREIGN!',
		})
		await expect(
			readConversationEvidence(
				f.sessions,
				f.sessionId,
				{ runId: f.runId, seq: 2 },
				undefined,
				f.active,
			),
		).rejects.toThrow('different owner')
	},
)

it.each(['foreign-scope', 'wrong-seq', 'wrong-part', 'excess-bytes'] as const)(
	'rejects invalid cold address lookup before reading (%s)',
	async (variant) => {
		const f = await fixture()
		const page = { ...f.searchPage }
		if (variant === 'foreign-scope') page.scope = { ...f.scope, sessionId: generateRunId() }
		if (variant === 'wrong-seq') page.matches = [{ ...f.match, seq: 3 }]
		if (variant === 'wrong-part') page.matches = [{ ...f.match, part: 1 }]
		if (variant === 'excess-bytes') page.scannedBytes = 9 * 1024 * 1024
		f.search.mockResolvedValueOnce(page)
		await expect(
			readConversationEvidence(
				f.sessions,
				f.sessionId,
				{ runId: f.runId, seq: 2 },
				undefined,
				f.active,
			),
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
] as const)('rejects an invalid read page (%s)', async (variant) => {
	const f = await fixture()
	const page = { ...f.readPage }
	if (variant === 'negative-bytes') page.scannedBytes = -1
	if (variant === 'excess-bytes') page.scannedBytes = 8 * 1024 * 1024
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
	f.read.mockResolvedValue(page)
	await expect(
		readConversationEvidence(
			f.sessions,
			f.sessionId,
			{ runId: f.runId, seq: 2 },
			undefined,
			f.active,
		),
	).rejects.toThrow()
})

it('rejects cancellation even if the captured reader ignores it and returns a valid page', async () => {
	const f = await fixture()
	const controller = new AbortController()
	f.read.mockImplementation(async () => {
		controller.abort(new Error('Cancelled evidence read'))
		return f.readPage
	})
	await expect(
		readConversationEvidence(
			f.sessions,
			f.sessionId,
			{ runId: f.runId, seq: 2 },
			controller.signal,
			f.active,
		),
	).rejects.toThrow('Cancelled evidence read')
})

it('preserves exact Unicode and unknown character counts in a valid read', async () => {
	const f = await fixture('İ🦉')
	const page = await readConversationEvidence(
		f.sessions,
		f.sessionId,
		{ runId: f.runId, seq: 2 },
		undefined,
		f.active,
	)
	expect(page.text).toBe('İ🦉')
	expect(page.totalChars).toBeUndefined()
	expect(page.complete).toBe(true)
	expect(page.scannedBytes).toBe(200)
})

it.each(['unavailable', 'preview-complete', 'offset-complete'] as const)(
	'rejects contradictory search completeness (%s)',
	async (variant) => {
		const f = await fixture()
		const page = { ...f.searchPage }
		if (variant === 'unavailable') page.unavailable = ['Missing original']
		if (variant === 'preview-complete')
			page.matches = [{ ...f.match, retained: 'preview', excerptComplete: true }]
		if (variant === 'offset-complete')
			page.matches = [{ ...f.match, byteOffset: 1, excerptComplete: true }]
		f.search.mockResolvedValue(page)
		const result = await searchConversation(
			f.sessions,
			f.sessionId,
			{ runId: f.runId, query: 'ORIGINAL' },
			undefined,
			f.active,
		)
		expect(result.matches).toEqual([])
		expect(result.incomplete).toBe(true)
	},
)

it('validates the whole match batch before binding even its first valid address', async () => {
	const f = await fixture()
	f.search.mockResolvedValueOnce({ ...f.searchPage, matches: [f.match, { ...f.match, part: -1 }] })
	const result = await searchConversation(
		f.sessions,
		f.sessionId,
		{ runId: f.runId, query: 'ORIGINAL' },
		undefined,
		f.active,
	)
	expect(result.matches).toEqual([])
	await readConversationEvidence(
		f.sessions,
		f.sessionId,
		{ runId: f.runId, seq: 2 },
		undefined,
		f.active,
	)
	expect(f.search).toHaveBeenCalledTimes(2)
})

it('uses the same page checks for automatic recall before any candidate is prepared', async () => {
	const f = await fixture()
	f.search.mockResolvedValue({
		...f.searchPage,
		matches: [{ ...f.match, excerpt: 'x'.repeat(513) }],
	})
	const recall = createConversationEvidenceRecall(f.sessions, f.sessionId, () => {})
	await expect(
		recall({
			runId: f.runId,
			stepNumber: 1,
			steps: [],
			prepared: {},
			messages: [{ role: 'user', content: 'ORIGINAL' }],
			captureRunEvidence: f.active.captureRunEvidence,
		}),
	).rejects.toThrow('retrieval bounds')
	expect(f.search).toHaveBeenCalledOnce()
})
