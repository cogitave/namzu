import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RunTextEvidenceSource, generateRunId } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	readConversationEvidence,
	releaseConversationEvidence,
	searchConversation,
} from './conversation-search.js'
import { CliPathBuilder } from './paths.js'
import { type CliSessions, openSessions, startConversation } from './store.js'

const owners: {
	root: string
	sessions: CliSessions
	sessionId: Awaited<ReturnType<typeof startConversation>>
}[] = []
afterEach(async () => {
	for (const { root, sessions, sessionId } of owners.splice(0)) {
		await releaseConversationEvidence(sessions, sessionId)
		removeTempDir(root)
	}
})

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-index-pages-test-'))
	const sessions = await openSessions(root)
	const sessionId = await startConversation(sessions)
	owners.push({ root, sessions, sessionId })
	const runId = generateRunId()
	const scope = { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId }
	const path = new CliPathBuilder(sessions.root).runDir(sessions.projectId, sessionId, runId)
	async function archive(contents: string[]) {
		await mkdir(path, { recursive: true })
		await writeFile(
			join(path, 'run.json'),
			JSON.stringify({ id: runId, status: 'completed', metadata: { scope } }),
		)
		const events = [
			{ type: 'run_started', runId, seq: 1 },
			...contents.map((content, i) => ({ type: 'message_completed', runId, seq: i + 2, content })),
			{ type: 'run_completed', runId, seq: contents.length + 2 },
		]
		await writeFile(
			join(path, 'transcript.jsonl'),
			`${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
		)
	}
	function page(nextCursor: string | null) {
		return {
			scope,
			matches: [],
			nextCursor,
			scannedBytes: 1024,
			indexedRecords: 0,
			cacheHit: true,
			incomplete: false,
			unavailable: [],
		}
	}
	function active(search: RunTextEvidenceSource['search']) {
		return {
			runId,
			captureRunEvidence: async () => ({
				scope,
				search,
				read: async () => {
					throw new Error('Unexpected read')
				},
			}),
		}
	}
	return { sessions, sessionId, runId, archive, page, active }
}

it('yields after bounded internal continuation work and resumes without skipping the late record', async () => {
	const f = await fixture()
	await f.archive([
		'TARGET announcement',
		...Array.from({ length: 640 }, (_, i) => `Other ${i}`),
		'TARGET original receipt',
	])
	const first = await searchConversation(f.sessions, f.sessionId, {
		query: 'TARGET',
		runId: f.runId,
	})
	expect(first.matches.map((m) => m.text)).toEqual(['TARGET announcement'])
	expect(first.scannedRuns).toBe(1)
	expect(first.nextCursor).toBeDefined()
	expect(first.incomplete).toBe(true)
	const second = await searchConversation(f.sessions, f.sessionId, { cursor: first.nextCursor })
	expect(second.matches.map((m) => m.text)).toEqual(['TARGET original receipt'])
	expect(second.incomplete).toBe(false)
	expect(second.nextCursor).toBeUndefined()
	for (const page of [first, second]) expect(page.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
	await releaseConversationEvidence(f.sessions, f.sessionId)
	const reopened = await openSessions(owners.at(-1)!.root)
	let exact = await readConversationEvidence(reopened, f.sessionId, second.matches[0]!)
	if (!exact.complete) {
		expect(exact.text).toBe('')
		expect(exact.nextCursor).toBeDefined()
		exact = await readConversationEvidence(reopened, f.sessionId, {
			...second.matches[0]!,
			cursor: exact.nextCursor,
		})
	}
	expect(exact.complete).toBe(true)
	expect(exact.text).toBe('TARGET original receipt')
})

it('reserves escaped output before each page and never loses or repeats a consumed match', async () => {
	const f = await fixture()
	await f.archive(Array.from({ length: 17 }, (_, i) => `TARGET ${i} ${'\u0001"\\'.repeat(170)}`))
	let cursor: string | undefined
	const sequences: number[] = []
	let pages = 0
	do {
		const page = await searchConversation(
			f.sessions,
			f.sessionId,
			cursor ? { cursor, limit: 20 } : { query: 'TARGET', runId: f.runId, limit: 20 },
		)
		expect(Buffer.byteLength(JSON.stringify(page.matches))).toBeLessThanOrEqual(12_000)
		expect(page.matches.length).toBeLessThanOrEqual(20)
		expect(page.scannedRuns).toBe(1)
		expect(page.unavailableRuns).toBe(0)
		sequences.push(...page.matches.map((m) => m.seq))
		cursor = page.nextCursor
		expect(++pages).toBeLessThan(10)
	} while (cursor)
	expect(pages).toBeGreaterThan(1)
	expect(sequences).toEqual(Array.from({ length: 17 }, (_, i) => i + 2))
})

it('allows at most seven internal resumes even for zero-cost advancing pages', async () => {
	const f = await fixture()
	let count = 0
	const search = vi.fn(async () => ({ ...f.page(`next-${++count}`), scannedBytes: 0 }))
	const result = await searchConversation(
		f.sessions,
		f.sessionId,
		{ query: 'TARGET', runId: f.runId },
		undefined,
		f.active(search),
	)
	expect(search).toHaveBeenCalledTimes(8)
	expect(result.scannedRuns).toBe(1)
	expect(result.nextCursor).toBeDefined()
})

it('does not keep resuming a source which returns the same cursor', async () => {
	const f = await fixture()
	const search = vi.fn(async () => f.page('unchanged'))
	const result = await searchConversation(
		f.sessions,
		f.sessionId,
		{ query: 'TARGET', runId: f.runId },
		undefined,
		f.active(search),
	)
	expect(search).toHaveBeenCalledTimes(2)
	expect(result.nextCursor).toBeDefined()
})

it('preserves cancellation between internal pages instead of returning partial success', async () => {
	const f = await fixture()
	const controller = new AbortController()
	const search = vi.fn(async () => {
		if (search.mock.calls.length === 2) controller.abort(new Error('Cancelled inside continuation'))
		return f.page(`next-${search.mock.calls.length}`)
	})
	await expect(
		searchConversation(
			f.sessions,
			f.sessionId,
			{ query: 'TARGET', runId: f.runId },
			controller.signal,
			f.active(search),
		),
	).rejects.toThrow('Cancelled inside continuation')
	expect(search).toHaveBeenCalledTimes(2)
})

it('discards this response’s earlier matches from a run whose next internal page fails', async () => {
	const f = await fixture()
	const search = vi.fn<RunTextEvidenceSource['search']>()
	search.mockResolvedValueOnce({
		...f.page('next'),
		matches: [
			{
				address: 'opaque',
				seq: 2,
				part: 0,
				source: 'message_completed',
				retained: 'full',
				excerpt: 'TARGET before source changed',
				byteOffset: 0,
			},
		],
	})
	search.mockRejectedValueOnce(new Error('Source changed during internal continuation'))
	const result = await searchConversation(
		f.sessions,
		f.sessionId,
		{ query: 'TARGET', runId: f.runId },
		undefined,
		f.active(search),
	)
	expect(result.matches).toEqual([])
	expect(result.unavailableRuns).toBe(1)
	expect(result.scannedRuns).toBe(1)
	expect(result.incomplete).toBe(true)
	expect(result.scannedBytes).toBe(8 * 1024 * 1024)
})

it('counts an unavailable run once across pages and keeps its incomplete status at exhaustion', async () => {
	const f = await fixture()
	const search = vi.fn<RunTextEvidenceSource['search']>()
	search.mockResolvedValueOnce({
		...f.page('next'),
		incomplete: true,
		unavailable: ['First missing original'],
	})
	search.mockResolvedValueOnce({
		...f.page(null),
		incomplete: true,
		unavailable: ['Second missing original'],
	})
	const result = await searchConversation(
		f.sessions,
		f.sessionId,
		{ query: 'TARGET', runId: f.runId },
		undefined,
		f.active(search),
	)
	expect(result.unavailableRuns).toBe(1)
	expect(result.scannedRuns).toBe(1)
	expect(result.incomplete).toBe(true)
	expect(result.nextCursor).toBeUndefined()
})

it('yields before another indexed operation cannot fit the remaining read reservation', async () => {
	const f = await fixture()
	const search = vi.fn(async () => ({ ...f.page('next'), scannedBytes: 2.5 * 1024 * 1024 }))
	const result = await searchConversation(
		f.sessions,
		f.sessionId,
		{ query: 'TARGET', runId: f.runId },
		undefined,
		f.active(search),
	)
	expect(search).toHaveBeenCalledTimes(1)
	expect(result.scannedBytes).toBe(2.5 * 1024 * 1024)
	expect(result.nextCursor).toBeDefined()
})
