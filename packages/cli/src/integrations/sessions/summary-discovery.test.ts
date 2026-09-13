import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
	RunDiskStore,
	type RunTextEvidenceSource,
	createUserMessage,
	generateRunId,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import * as search from './conversation-search.js'
import { createConversationEvidenceRecall } from './evidence-recall.js'
import { CliPathBuilder } from './paths.js'
import { openSessions, startConversation } from './store.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const close of cleanup.splice(0)) await close()
})

async function fixture(backend: 'live' | 'closed' | 'legacy', originalCount = 10) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-summary-discovery-'))
	const sessions = await openSessions(root)
	const sessionId = await startConversation(sessions)
	cleanup.push(async () => {
		await search.releaseConversationEvidence(sessions, sessionId)
		removeTempDir(root)
	})
	const runId = generateRunId()
	const scope = { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId }
	const path = new CliPathBuilder(sessions.root).runDir(sessions.projectId, sessionId, runId)
	const store = new RunDiskStore({ baseDir: dirname(path) })
	await store.initRun(runId)
	if (backend !== 'legacy')
		await writeFile(
			join(path, 'run.json'),
			JSON.stringify({
				id: runId,
				status: backend === 'live' ? 'running' : 'completed',
				metadata: { scope },
			}),
		)
	await store.appendEvent({ type: 'run_started', runId, seq: 1 })
	await store.appendEvent({
		type: 'compaction_shed',
		runId,
		seq: 2,
		iteration: 1,
		reason: 'threshold',
		messages: [
			...Array.from({ length: 20 }, (_, i) => ({
				role: 'system' as const,
				source: { type: 'compaction-summary' as const },
				content: `ORCHID receipt summary ${i}`,
			})),
			...Array.from({ length: originalCount }, (_, i) => ({
				role: 'tool' as const,
				toolCallId: `read-${i}`,
				isError: false,
				content: `ORCHID original receipt CODE-${i}`,
			})),
		],
	})
	const runtime = {
		runId,
		captureRunEvidence: (bytes?: number, signal?: AbortSignal) =>
			store.captureTextEvidence(scope, bytes, signal),
	}
	return { sessions, sessionId, store, runId, runtime }
}

it.each(['live', 'closed', 'legacy'] as const)(
	'discovers originals past repeated summaries within four pages (%s)',
	async (backend) => {
		const f = await fixture(backend)
		const history = vi.spyOn(search, 'searchConversationTerms')
		const liveSearches: Parameters<RunTextEvidenceSource['search']>[0][] = []
		const recall = createConversationEvidenceRecall(f.sessions, f.sessionId, () => {})
		const result = await recall({
			runId: backend === 'live' ? f.runId : generateRunId(),
			stepNumber: 1,
			steps: [],
			prepared: {},
			messages: [createUserMessage('What was the ORCHID receipt?')],
			...(backend === 'live'
				? {
						captureRunEvidence: async (bytes?: number) => {
							const source = (await f.runtime.captureRunEvidence(bytes))!
							return {
								...source,
								search: (...args: Parameters<RunTextEvidenceSource['search']>) => {
									liveSearches.push(args[0])
									return source.search(...args)
								},
							}
						},
					}
				: {}),
		})
		const metadata = JSON.parse(result!.context!.split('\n')[1]!)
		expect(result!.context).toContain('CODE-0')
		expect(metadata).toMatchObject({ incomplete: true, excludedSummaries: 20 })
		expect(metadata.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
		expect(result!.context!.length).toBeLessThanOrEqual(6000)
		expect(liveSearches.length).toBeLessThanOrEqual(2)
		expect(history.mock.calls.length + liveSearches.length).toBeLessThanOrEqual(4)
		expect(
			[...liveSearches, ...history.mock.calls.map((c) => c[2])].some(
				(s) => s?.excludeDerivedSummaries === true,
			),
		).toBe(true)
		const continuations = metadata.continuations as { input: { cursor: string } }[]
		expect(continuations.length).toBeGreaterThan(0)
		const continued = await Promise.all(
			continuations.map((hint) =>
				search.searchConversation(
					f.sessions,
					f.sessionId,
					hint.input,
					undefined,
					backend === 'live' ? f.runtime : undefined,
				),
			),
		)
		expect(
			continued.some((page) => page.matches.some((m) => m.source === 'compaction_shed:summary')),
		).toBe(true)
		expect((await f.store.readEvents()).map((e) => e.type)).toEqual([
			'run_started',
			'compaction_shed',
		])
	},
)

it.each(['live', 'closed', 'legacy'] as const)(
	'restores the focused filter from an explicit cursor and keeps unfiltered reads (%s)',
	async (backend) => {
		const f = await fixture(backend)
		const request = {
			terms: ['ORCHID'],
			excludeRunId: generateRunId(),
			maxReadBytes: 8 * 1024 * 1024,
			excludeDerivedSummaries: true,
		}
		let cursor: string
		if (backend === 'live') {
			const source = (await f.runtime.captureRunEvidence())!
			const first = await source.search({
				terms: request.terms,
				excludeDerivedSummaries: true,
				caseSensitive: false,
				limit: 1,
			})
			cursor = search.retainLiveConversationSearch(
				f.sessions,
				f.sessionId,
				f.runId,
				request.terms,
				first.nextCursor!,
				false,
				'literal',
				undefined,
				true,
			)
		} else
			cursor = (await search.searchConversationTerms(f.sessions, f.sessionId, request)).nextCursor!
		expect(cursor).toBeDefined()
		const page = await search.searchConversation(
			f.sessions,
			f.sessionId,
			{ cursor },
			undefined,
			backend === 'live' ? f.runtime : undefined,
		)
		expect(page.matches.length).toBeGreaterThan(0)
		expect(page.matches.every((m) => m.source !== 'compaction_shed:summary')).toBe(true)
		expect(page.guidance).toContain('excludes known derived summaries')
		if (backend !== 'live')
			await expect(
				search.searchConversationTerms(f.sessions, f.sessionId, {
					...request,
					cursor,
					excludeDerivedSummaries: false,
				}),
			).rejects.toThrow('scope or query')
		const foreign = await startConversation(f.sessions)
		await expect(
			search.searchConversation(
				f.sessions,
				foreign,
				{ cursor },
				undefined,
				backend === 'live' ? f.runtime : undefined,
			),
		).rejects.toThrow('scope or query')
		const literal = await search.searchConversation(
			f.sessions,
			f.sessionId,
			{ query: 'ORCHID', runId: f.runId },
			undefined,
			backend === 'live' ? f.runtime : undefined,
		)
		expect(literal.matches[0]!.source).toBe('compaction_shed:summary')
		const exact = await search.readConversationEvidence(
			f.sessions,
			f.sessionId,
			{ runId: f.runId, seq: 2, part: 0 },
			undefined,
			backend === 'live' ? f.runtime : undefined,
		)
		expect(exact.text).toBe('ORCHID receipt summary 0')
	},
)

it('keeps summary-only evidence when a focused source scan is empty', async () => {
	const f = await fixture('closed', 0)
	const history = vi.spyOn(search, 'searchConversationTerms')
	const result = await createConversationEvidenceRecall(f.sessions, f.sessionId, () => {})({
		runId: generateRunId(),
		stepNumber: 1,
		steps: [],
		prepared: {},
		messages: [createUserMessage('What was the ORCHID receipt?')],
	})
	expect(result?.context).toContain('ORCHID receipt summary 0')
	expect(history.mock.calls.map((c) => c[2].excludeDerivedSummaries ?? false)).toEqual([
		false,
		true,
		false,
		false,
	])
	expect(JSON.parse(result!.context!.split('\n')[1]!)).toMatchObject({
		incomplete: true,
		excludedSummaries: 20,
	})
})

it('refuses a malformed legacy role instead of interpreting it as a derived-summary source', async () => {
	const f = await fixture('legacy', 0)
	await f.store.appendEvent({
		type: 'compaction_shed',
		runId: f.runId,
		seq: 3,
		iteration: 2,
		reason: 'threshold',
		messages: [{ role: 'summary', content: 'POISON invented summary role' } as never],
	})
	const result = await search.searchConversationTerms(f.sessions, f.sessionId, {
		terms: ['POISON'],
		excludeRunId: generateRunId(),
		maxReadBytes: 8 * 1024 * 1024,
		excludeDerivedSummaries: true,
	})
	expect(result.matches).toEqual([])
	expect(result.incomplete).toBe(true)
	expect(result.unavailableRuns).toBe(1)
	expect(result.excludedSummaries).toBe(20)
})
