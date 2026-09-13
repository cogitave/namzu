import { mkdir, mkdtemp, opendir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
	MockLLMProvider,
	RunDiskStore,
	type RunEvent,
	type RunTextEvidenceSource,
	type SessionId,
	ToolRegistry,
	asRunId,
	createAssistantMessage,
	createUserMessage,
	defineTool,
	generateRunId,
	mcpJsonSchemaToZod,
	query,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { retainManualCompaction } from './compaction-evidence.js'
import {
	readConversationEvidence,
	releaseConversationEvidence,
	retainLiveConversationSearch,
	searchConversation,
	searchConversationTerms,
} from './conversation-search.js'
import * as conversationSearch from './conversation-search.js'
import { createConversationEvidenceRecall } from './evidence-recall.js'
import { CliPathBuilder } from './paths.js'
import {
	type CliSessions,
	appendMessages,
	loadConversation,
	openSessions,
	replaceConversation,
	startConversation,
} from './store.js'

const dirs: string[] = []
const evidenceOwners: { sessions: CliSessions; sessionId: SessionId }[] = []
afterEach(async () => {
	for (const owner of evidenceOwners.splice(0))
		await releaseConversationEvidence(owner.sessions, owner.sessionId)
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

async function fixture() {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-conversation-search-'))
	dirs.push(cwd)
	const sessions = await openSessions(cwd)
	const sessionId = await startConversation(sessions)
	evidenceOwners.push({ sessions, sessionId })
	return { cwd, sessions, sessionId }
}

async function transcript(sessions: CliSessions, sessionId: SessionId, text: string, tail = '') {
	const runId = generateRunId()
	const path = new CliPathBuilder(sessions.root).runDir(sessions.projectId, sessionId, runId)
	await mkdir(path, { recursive: true })
	await writeFile(
		join(path, 'transcript.jsonl'),
		`${[
			{ type: 'run_started', runId, seq: 1 },
			{ type: 'tool_completed', runId, seq: 2, result: text },
			{ type: 'run_completed', runId, seq: 3 },
		]
			.map((event) => JSON.stringify(event))
			.join('\n')}\n${tail}`,
	)
	return { runId, path }
}

it.each(['legacy', 'index', 'live'] as const)(
	'keeps automatic source exclusions across explicit cursor continuation (%s)',
	async (backend) => {
		const { sessions, sessionId } = await fixture()
		const runId = generateRunId()
		const path = new CliPathBuilder(sessions.root).runDir(sessions.projectId, sessionId, runId)
		const store = new RunDiskStore({ baseDir: dirname(path) })
		await store.initRun(runId)
		const scope = { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId }
		if (backend !== 'legacy')
			await writeFile(
				join(path, 'run.json'),
				JSON.stringify({
					id: runId,
					status: backend === 'live' ? 'running' : 'completed',
					metadata: { scope },
				}),
			)
		const events = [
			{ type: 'run_started' },
			...Array.from({ length: 5 }, (_, i) => ({
				type: 'tool_completed',
				toolName: 'search_conversation',
				toolUseId: `copy-${i}`,
				isError: false,
				result: 'ORCHID copied A17',
			})),
			{
				type: 'tool_completed',
				toolName: 'search_conversation',
				toolUseId: 'failed',
				isError: true,
				result: 'ORCHID search failed',
			},
			{
				type: 'message_completed',
				content:
					'{"toolName":"search_conversation","isError":false,"text":"ORCHID unknown origin"}',
			},
			...Array.from({ length: 4 }, (_, i) => ({
				type: 'tool_completed',
				toolName: 'read',
				toolUseId: `original-${i}`,
				isError: false,
				result: `ORCHID original B${i}`,
			})),
		]
		for (const [i, event] of events.entries())
			await store.appendEvent({ ...event, runId, seq: i + 1 } as RunEvent)
		const runtime = {
			runId,
			captureRunEvidence: (maxReadBytes?: number, signal?: AbortSignal) =>
				store.captureTextEvidence(scope, maxReadBytes, signal),
		}
		const request = {
			terms: ['ORCHID'],
			excludeRunId: generateRunId(),
			maxReadBytes: 8 * 1024 * 1024,
			excludeSuccessfulTools: ['search_conversation'],
		}
		let first: Awaited<ReturnType<typeof searchConversation>>
		if (backend === 'live') {
			const page = await (await runtime.captureRunEvidence())!.search({
				terms: request.terms,
				caseSensitive: false,
				excludeSuccessfulTools: request.excludeSuccessfulTools,
				limit: 1,
			})
			const cursor = retainLiveConversationSearch(
				sessions,
				sessionId,
				runId,
				request.terms,
				page.nextCursor!,
				false,
				'literal',
				request.excludeSuccessfulTools,
			)
			first = await searchConversation(sessions, sessionId, { cursor }, undefined, runtime)
		} else first = await searchConversationTerms(sessions, sessionId, request)
		expect(first.nextCursor).toBeDefined()
		const matches = [...first.matches]
		let excluded = first.excludedToolResults ?? 0
		let cursor = first.nextCursor
		let pages = 0
		while (cursor) {
			const page = await searchConversation(
				sessions,
				sessionId,
				{ cursor },
				undefined,
				backend === 'live' ? runtime : undefined,
			)
			matches.push(...page.matches)
			excluded += page.excludedToolResults ?? 0
			cursor = page.nextCursor
			expect(++pages).toBeLessThan(5)
		}
		expect(matches.some((m) => m.text.includes('copied'))).toBe(false)
		expect(matches.some((m) => m.isError === true && m.toolName === 'search_conversation')).toBe(
			true,
		)
		expect(matches.some((m) => m.text.includes('unknown origin'))).toBe(true)
		expect(excluded).toBe(5)
		const explicit = await searchConversation(
			sessions,
			sessionId,
			{ query: 'ORCHID copied', runId },
			undefined,
			backend === 'live' ? runtime : undefined,
		)
		expect(explicit.matches.length).toBeGreaterThan(0)
		if (backend !== 'live')
			await expect(
				searchConversationTerms(sessions, sessionId, {
					...request,
					cursor: first.nextCursor,
					excludeSuccessfulTools: [],
				}),
			).rejects.toThrow('scope or query')
		const foreign = await startConversation(sessions)
		await expect(
			searchConversation(sessions, foreign, { cursor: first.nextCursor }),
		).rejects.toThrow('scope or query')
	},
)

it.each([false, true])(
	'recovers exact rich tool text after manual compaction and reopen (archive=%s)',
	async (archived) => {
		const { cwd, sessions, sessionId } = await fixture()
		const text = 'ORCHID original receipt İ 😀\r\nno inserted separators'
		await retainManualCompaction(sessions, sessionId, [
			createUserMessage('Before observation'),
			{
				role: 'tool',
				toolCallId: 'observation',
				timestamp: 1,
				isError: false,
				content: [
					{ type: 'text', text },
					{
						type: 'image',
						data: archived ? 'A'.repeat(4 * 1024 * 1024) : 'ONLY_BINARY',
						mediaType: 'image/png',
					},
					{ type: 'text', text: 'ORCHID second independent block' },
				],
			},
			createUserMessage('After observation'),
		])
		await replaceConversation(sessions, sessionId, [createUserMessage('History compacted.')])
		const first = await searchConversation(sessions, sessionId, { query: 'ORCHID', limit: 1 })
		expect(first.matches).toHaveLength(1)
		expect(first.matches[0]).toMatchObject({
			source: 'compaction_shed:tool',
			part: 2,
			isError: false,
		})
		const { runId, seq, part } = first.matches[0]!
		await releaseConversationEvidence(sessions, sessionId)
		const reopened = await openSessions(cwd)
		evidenceOwners.push({ sessions: reopened, sessionId })
		const exact = await readConversationEvidence(reopened, sessionId, { runId, seq, part })
		expect(exact).toMatchObject({ text, complete: true, retainedPreview: false })
		const oldPlainAddress = await readConversationEvidence(reopened, sessionId, {
			runId,
			seq,
			part: 1,
		})
		expect(oldPlainAddress.text).toBe('After observation')
		expect(
			(await searchConversation(reopened, sessionId, { query: 'ONLY_BINARY' })).matches,
		).toEqual([])
		const foreign = await startConversation(reopened)
		await expect(
			readConversationEvidence(reopened, foreign, { runId, seq, part }),
		).rejects.toThrow()
	},
)

it('marks unindexed rich compaction text incomplete without renumbering existing plain parts', async () => {
	const { sessions, sessionId } = await fixture()
	const { path, runId } = await transcript(sessions, sessionId, 'seed')
	await writeFile(
		join(path, 'transcript.jsonl'),
		`${[
			{ type: 'run_started', runId, seq: 1 },
			{
				type: 'compaction_shed',
				runId,
				seq: 2,
				messages: [
					{ role: 'tool', content: [{ type: 'text', text: 'ORCHID hidden' }] },
					{ role: 'user', content: 'ORCHID retained plain part' },
				],
			},
		]
			.map((event) => JSON.stringify(event))
			.join('\n')}\n`,
	)
	const result = await searchConversation(sessions, sessionId, { query: 'ORCHID' })
	expect(result.incomplete).toBe(true)
	expect(result.matches).toHaveLength(1)
	expect(result.matches[0]).toMatchObject({ text: 'ORCHID retained plain part', part: 0 })
})

it('refuses retained compaction references on the unscoped legacy scanner', async () => {
	const { sessions, sessionId } = await fixture()
	const { path, runId } = await transcript(sessions, sessionId, 'Unrelated earlier text')
	await writeFile(
		join(path, 'transcript.jsonl'),
		`${[
			{ type: 'run_started', runId, seq: 1 },
			{ type: 'compaction_archive', runId, seq: 2, archive: { id: 'untrusted' } },
		]
			.map((event) => JSON.stringify(event))
			.join('\n')}\n`,
	)
	const result = await searchConversation(sessions, sessionId, { query: 'ORCHID' })
	expect(result.matches).toEqual([])
	expect(result.incomplete).toBe(true)
	expect(result.unavailableRuns).toBe(1)
})

async function closedTranscript(
	sessions: CliSessions,
	sessionId: SessionId,
	order: number,
	text: string,
) {
	const runId = asRunId(`00000000-0000-4000-8000-${order.toString(16).padStart(12, '0')}`)
	const path = new CliPathBuilder(sessions.root).runDir(sessions.projectId, sessionId, runId)
	const store = new RunDiskStore({ baseDir: dirname(path) })
	await store.initRun(runId)
	await store.appendEvent({ type: 'run_started', runId, seq: 1 } as RunEvent)
	await store.appendEvent({ type: 'message_completed', runId, seq: 2, content: text } as RunEvent)
	await store.appendEvent({ type: 'run_completed', runId, seq: 3 } as RunEvent)
	await writeFile(
		join(path, 'run.json'),
		JSON.stringify({
			id: runId,
			status: 'completed',
			metadata: {
				scope: { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId },
			},
		}),
	)
	return { runId, path }
}

describe('bounded original conversation evidence', () => {
	it('bounds escaped multi-run candidate pages and resumes without dropping matches', async () => {
		const { sessions, sessionId } = await fixture()
		for (let i = 1; i <= 8; i++)
			await closedTranscript(sessions, sessionId, i, `ORCHID ${i} ${'\u0000'.repeat(480)}`)
		const request = {
			terms: ['ORCHID'],
			excludeRunId: generateRunId(),
			maxReadBytes: 8 * 1024 * 1024,
		}
		let cursor: string | undefined
		const runs: string[] = []
		let pages = 0
		do {
			const page = await searchConversationTerms(sessions, sessionId, { ...request, cursor })
			expect(Buffer.byteLength(JSON.stringify(page.matches))).toBeLessThanOrEqual(12_000)
			expect(page.scannedBytes).toBeLessThanOrEqual(request.maxReadBytes)
			expect(page.unavailableRuns).toBe(0)
			runs.push(...page.matches.map((m) => m.runId))
			cursor = page.nextCursor
			if (!cursor) expect(page.incomplete).toBe(false)
			expect(++pages).toBeLessThan(12)
		} while (cursor)
		expect(runs).toHaveLength(8)
		expect(new Set(runs).size).toBe(8)
		expect(pages).toBeGreaterThan(1)
	})

	it.each(['string', 'blocks'] as const)(
		'recalls missing archived text before repeated visible %s results',
		async (shape) => {
			const { sessions, sessionId } = await fixture()
			const visible = Array.from(
				{ length: 4 },
				(_, i) => `ORCHID original receipt code: not recorded on copy ${i}.`,
			)
			for (const [i, text] of visible.entries())
				await closedTranscript(sessions, sessionId, i + 1, text)
			const original = `ORCHID original receipt code RECEIPT-A17. ${'Archive accompanying notes. '.repeat(11)}`
			const target = await closedTranscript(sessions, sessionId, 5, original)
			const recall = createConversationEvidenceRecall(sessions, sessionId, () => {})
			const result = await recall({
				runId: generateRunId(),
				stepNumber: 1,
				steps: [],
				prepared: {},
				messages: [
					createUserMessage('What was the original ORCHID receipt code?'),
					...visible.map((text, i) => ({
						role: 'tool' as const,
						toolCallId: `read-${i}`,
						content: shape === 'string' ? text : [{ type: 'text' as const, text }],
					})),
				],
			})
			const text = result!.context!
			const selected = text
				.split('\n')
				.filter((line) => line.startsWith('{"runId":'))
				.map((line) => JSON.parse(line))
			expect(selected.map((entry) => entry.runId)).toEqual([target.runId])
			const metadata = JSON.parse(text.split('\n')[1]!)
			expect(metadata.visibleEvidence).toHaveLength(3)
			expect(metadata.omittedVisibleEvidence).toBe(1)
			expect(metadata.omittedPassages).toBe(0)
			expect(text.length).toBeLessThanOrEqual(6000)
			await releaseConversationEvidence(sessions, sessionId)
			expect(
				await readConversationEvidence(sessions, sessionId, {
					runId: target.runId,
					seq: 2,
					part: 0,
				}),
			).toMatchObject({ text: original, complete: true })
		},
	)

	it.each([0, 250_000])(
		'crosses exhausted nonmatching indexed runs within the shared byte ceiling (payload %i)',
		async (padding) => {
			const { sessions, sessionId } = await fixture()
			for (let i = 1; i <= 16; i++)
				await closedTranscript(sessions, sessionId, i, `Unrelated ${i} ${'x'.repeat(padding)}`)
			const target = await closedTranscript(sessions, sessionId, 17, 'TARGET original receipt A17')
			const pages = []
			let cursor: string | undefined
			do {
				const page = await searchConversation(
					sessions,
					sessionId,
					cursor ? { cursor } : { query: 'TARGET' },
				)
				pages.push(page)
				expect(page.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
				expect(page.scannedRuns).toBeLessThanOrEqual(100)
				expect(page.unavailableRuns).toBe(0)
				expect(Buffer.byteLength(JSON.stringify(page.matches))).toBeLessThanOrEqual(12_000)
				cursor = page.nextCursor
				expect(pages.length).toBeLessThan(17)
			} while (cursor)
			if (padding === 0) {
				expect(pages).toHaveLength(1)
				expect(pages[0]!.scannedRuns).toBe(17)
				const recall = createConversationEvidenceRecall(sessions, sessionId, () => {})
				const prepared = await recall({
					runId: generateRunId(),
					messages: [createUserMessage('TARGET')],
					steps: [],
					prepared: {},
					stepNumber: 1,
				})
				expect(prepared?.context).toContain('TARGET original receipt A17')
			} else expect(pages.length).toBeGreaterThan(1)
			expect(pages.at(-1)!.incomplete).toBe(false)
			expect(pages.flatMap((page) => page.matches)).toEqual([
				expect.objectContaining({
					runId: target.runId,
					seq: 2,
					text: 'TARGET original receipt A17',
				}),
			])
		},
	)

	it('does not skip a nonmatching partial index when a later run already matches', async () => {
		const { sessions, sessionId } = await fixture()
		await closedTranscript(sessions, sessionId, 1, 'Unrelated complete run')
		const partial = await closedTranscript(sessions, sessionId, 2, 'Replaced fixture')
		const events = [
			{ type: 'run_started', runId: partial.runId, seq: 1 },
			...Array.from({ length: 70 }, (_, i) => ({
				type: 'message_completed',
				runId: partial.runId,
				seq: i + 2,
				content: i === 69 ? 'TARGET within partial run' : `Unrelated message ${i}`,
			})),
		]
		await writeFile(
			join(partial.path, 'transcript.jsonl'),
			`${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
		)
		const later = await closedTranscript(sessions, sessionId, 3, 'TARGET in later run')
		const first = await searchConversation(sessions, sessionId, { query: 'TARGET' })
		expect(first.matches).toEqual([])
		expect(first.scannedRuns).toBe(2)
		expect(first.incomplete).toBe(true)
		expect(first.nextCursor).toBeDefined()
		const second = await searchConversation(sessions, sessionId, { cursor: first.nextCursor })
		expect(second.matches).toEqual([expect.objectContaining({ runId: partial.runId, seq: 71 })])
		const third = await searchConversation(sessions, sessionId, { cursor: second.nextCursor })
		expect(third.matches).toEqual([expect.objectContaining({ runId: later.runId })])
		expect(third.incomplete).toBe(false)
	})

	it('preserves unavailable ownership while crossing an exhausted empty index', async () => {
		const { sessions, sessionId } = await fixture()
		await closedTranscript(sessions, sessionId, 1, 'No relevant observation')
		const foreign = await closedTranscript(sessions, sessionId, 2, 'TARGET foreign secret')
		await writeFile(
			join(foreign.path, 'run.json'),
			JSON.stringify({
				id: foreign.runId,
				status: 'completed',
				metadata: {
					scope: {
						tenantId: sessions.tenantId,
						projectId: sessions.projectId,
						sessionId: await startConversation(sessions),
						runId: foreign.runId,
					},
				},
			}),
		)
		const target = await closedTranscript(sessions, sessionId, 3, 'TARGET own observation')
		const page = await searchConversation(sessions, sessionId, { query: 'TARGET' })
		expect(page.matches).toEqual([expect.objectContaining({ runId: target.runId })])
		expect(JSON.stringify(page)).not.toContain('foreign secret')
		expect(page.unavailableRuns).toBe(1)
		expect(page.incomplete).toBe(true)
		expect(page.nextCursor).toBeUndefined()
	})

	it.each(['live', 'closed', 'legacy'] as const)(
		'preserves event time in search, exact read and automatic context (%s)',
		async (backend) => {
			const { sessions, sessionId } = await fixture()
			const runId = generateRunId()
			const path = new CliPathBuilder(sessions.root).runDir(sessions.projectId, sessionId, runId)
			const owner = { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId }
			const store = new RunDiskStore({ baseDir: dirname(path) })
			await store.initRun(runId)
			if (backend !== 'legacy')
				await writeFile(
					join(path, 'run.json'),
					JSON.stringify({
						id: runId,
						status: backend === 'live' ? 'running' : 'completed',
						metadata: { scope: owner },
						startedAt: 1,
					}),
				)
			const recordedAt = Date.UTC(2025, 3, 7)
			const clock = vi.spyOn(Date, 'now').mockReturnValue(recordedAt)
			try {
				await store.appendEvent({ type: 'run_started', runId, seq: 1 } as RunEvent)
				await store.appendEvent({
					type: 'tool_completed',
					runId,
					seq: 2,
					toolUseId: 'read',
					toolName: 'read',
					isError: false,
					result: 'DELTA receipt CODE-17',
				} as RunEvent)
			} finally {
				clock.mockRestore()
			}
			const captureRunEvidence = (bytes?: number) => store.captureTextEvidence(owner, bytes)
			const active = backend === 'live' ? { runId, captureRunEvidence } : undefined
			const match = (
				await searchConversation(sessions, sessionId, { query: 'DELTA', runId }, undefined, active)
			).matches[0]!
			expect(match.recordedAt).toBe(recordedAt)
			const read = await readConversationEvidence(
				sessions,
				sessionId,
				{ runId, seq: 2 },
				undefined,
				active,
			)
			expect(read.recordedAt).toBe(recordedAt)
			expect(read.text).toBe('DELTA receipt CODE-17')
			const recall = createConversationEvidenceRecall(sessions, sessionId, () => {})
			const result = await recall({
				runId: active?.runId ?? generateRunId(),
				messages: [createUserMessage('DELTA')],
				steps: [],
				prepared: {},
				stepNumber: 1,
				...(active ? { captureRunEvidence } : {}),
			})
			expect(result?.context).toContain(`"recordedAt":${recordedAt}`)
			const visible = await recall({
				runId: active?.runId ?? generateRunId(),
				messages: [createUserMessage('DELTA'), createAssistantMessage('DELTA receipt CODE-17')],
				steps: [],
				prepared: {},
				stepNumber: 1,
				...(active ? { captureRunEvidence } : {}),
			})
			expect(visible?.context).not.toContain('"excerpt"')
			const metadata = JSON.parse(visible!.context!.split('\n')[1]!)
			expect(metadata.visibleEvidence).toHaveLength(1)
			const ref = metadata.visibleEvidence[0]
			expect(ref.textQuote).toBe('DELTA receipt CODE-17')
			expect(ref.recordedAt).toBe(recordedAt)
			const restored = await readConversationEvidence(
				sessions,
				sessionId,
				ref.address,
				undefined,
				active,
			)
			expect(restored.text).toBe('DELTA receipt CODE-17')
			expect(restored.recordedAt).toBe(recordedAt)
		},
	)

	it.each(['live', 'closed', 'legacy'] as const)(
		'keeps substring noise out of automatic recall (%s)',
		async (backend) => {
			const { sessions, sessionId } = await fixture()
			const runId = generateRunId()
			const path = new CliPathBuilder(sessions.root).runDir(sessions.projectId, sessionId, runId)
			const owner = { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId }
			const store = new RunDiskStore({ baseDir: dirname(path) })
			await store.initRun(runId)
			if (backend !== 'legacy')
				await writeFile(
					join(path, 'run.json'),
					JSON.stringify({
						id: runId,
						status: backend === 'live' ? 'running' : 'completed',
						metadata: { scope: owner },
					}),
				)
			await store.appendEvent({ type: 'run_started', runId, seq: 1 } as RunEvent)
			const noise = Array.from(
				{ length: 12 },
				(_, i) => `Packing information for unrelated entry ${i}`,
			)
			const target = 'DELTA original observation: receipt A17'
			const texts = backend === 'live' ? [target, ...noise] : [...noise, target]
			for (const [i, result] of texts.entries())
				await store.appendEvent({
					type: 'tool_completed',
					runId,
					seq: i + 2,
					toolName: 'read',
					toolUseId: `read-${i}`,
					isError: false,
					result,
				} as RunEvent)
			const captureRunEvidence = (maxReadBytes?: number) =>
				store.captureTextEvidence(owner, maxReadBytes)
			const recall = createConversationEvidenceRecall(sessions, sessionId, () => {})
			const ctx = {
				runId: backend === 'live' ? runId : generateRunId(),
				messages: [
					createUserMessage('Search the original DELTA observations in this conversation.'),
				],
				steps: [],
				prepared: {},
				stepNumber: 1,
				...(backend === 'live' ? { captureRunEvidence } : {}),
			}
			const result = await recall(ctx)
			expect(result?.context).toContain('receipt A17')
			expect(result?.context).not.toContain('Packing information')
			const literal = await searchConversation(
				sessions,
				sessionId,
				{ query: 'in', runId },
				undefined,
				backend === 'live' ? { runId, captureRunEvidence } : undefined,
			)
			expect(literal.matches.some((m) => m.text.includes('Packing information'))).toBe(true)
			expect((await store.readEvents()).filter((e) => e.type === 'tool_completed')).toHaveLength(13)
		},
	)

	it.each(['live', 'closed', 'legacy'] as const)(
		'retrieves uncovered terms before common whole words fill automatic recall (%s)',
		async (backend) => {
			const { sessions, sessionId } = await fixture()
			const runId = generateRunId()
			const path = new CliPathBuilder(sessions.root).runDir(sessions.projectId, sessionId, runId)
			const owner = { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId }
			const store = new RunDiskStore({ baseDir: dirname(path) })
			await store.initRun(runId)
			if (backend !== 'legacy')
				await writeFile(
					join(path, 'run.json'),
					JSON.stringify({
						id: runId,
						status: backend === 'live' ? 'running' : 'completed',
						metadata: { scope: owner },
					}),
				)
			await store.appendEvent({ type: 'run_started', runId, seq: 1 } as RunEvent)
			const noise = Array.from({ length: 24 }, (_, i) => `An unrelated item is in queue ${i}`)
			const target = 'DELTA original observation: receipt A17'
			const texts = backend === 'live' ? [target, ...noise] : [...noise, target]
			for (const [i, result] of texts.entries())
				await store.appendEvent({
					type: 'tool_completed',
					runId,
					seq: i + 2,
					toolName: 'read',
					toolUseId: `read-${i}`,
					isError: false,
					result,
				} as RunEvent)
			const captureRunEvidence = (maxReadBytes?: number) =>
				store.captureTextEvidence(owner, maxReadBytes)
			const recall = createConversationEvidenceRecall(sessions, sessionId, () => {})
			const ctx = {
				runId: backend === 'live' ? runId : generateRunId(),
				messages: [
					createUserMessage('Search the original DELTA observations in this conversation.'),
				],
				steps: [],
				prepared: {},
				stepNumber: 1,
				...(backend === 'live' ? { captureRunEvidence } : {}),
			}
			const result = await recall(ctx)
			expect(result?.context).toContain('receipt A17')
			expect(result?.context).toContain('"incomplete":true')
			expect((await store.readEvents()).filter((e) => e.type === 'tool_completed')).toHaveLength(25)
		},
	)

	it('keeps broad and focused live/history cursors within the original four-page budget', async () => {
		const { sessions, sessionId } = await fixture()
		async function source(live: boolean) {
			const runId = generateRunId()
			const owner = { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId }
			const path = new CliPathBuilder(sessions.root).runDir(sessions.projectId, sessionId, runId)
			const store = new RunDiskStore({ baseDir: dirname(path) })
			await store.initRun(runId)
			await writeFile(
				join(path, 'run.json'),
				JSON.stringify({
					id: runId,
					status: live ? 'running' : 'completed',
					metadata: { scope: owner },
				}),
			)
			await store.appendEvent({ type: 'run_started', runId, seq: 1 } as RunEvent)
			const noise = Array.from({ length: 12 }, (_, i) => `in queue ${i}`)
			const target = Array.from({ length: 6 }, (_, i) => `DELTA receipt ${i}`)
			for (const [i, result] of (live ? [...target, ...noise] : [...noise, ...target]).entries())
				await store.appendEvent({
					type: 'tool_completed',
					runId,
					seq: i + 2,
					result,
					toolName: 'read',
					toolUseId: `read-${i}`,
					isError: false,
				} as RunEvent)
			return { store, runId, owner }
		}
		const live = await source(true)
		await source(false)
		const liveTerms: (readonly string[])[] = []
		const remainingBudgets: number[] = []
		let liveBytes = 0
		const captureRunEvidence = async (maxReadBytes?: number) => {
			remainingBudgets.push(maxReadBytes!)
			const captured = await live.store.captureTextEvidence(live.owner, maxReadBytes)
			if (!captured) throw new Error('Expected active evidence writer')
			return {
				...captured,
				search: async (...args: Parameters<RunTextEvidenceSource['search']>) => {
					liveTerms.push(args[0]?.terms ?? [])
					const page = await captured.search(...args)
					liveBytes += page.scannedBytes
					return page
				},
			}
		}
		const history = vi.spyOn(conversationSearch, 'searchConversationTerms')
		try {
			const recall = createConversationEvidenceRecall(sessions, sessionId, () => {})
			const result = await recall({
				runId: live.runId,
				messages: [createUserMessage('in DELTA')],
				steps: [],
				prepared: {},
				stepNumber: 1,
				captureRunEvidence,
			})
			const metadata = JSON.parse(result!.context!.split('\n')[1]!)
			expect(liveTerms).toEqual([['in', 'DELTA'], ['DELTA']])
			expect(history).toHaveBeenCalledTimes(2)
			expect(history.mock.calls.map((call) => call[2].terms)).toEqual([['in', 'DELTA'], ['DELTA']])
			expect(history.mock.calls[0]![2].maxReadBytes).toBe(8 * 1024 * 1024 - liveBytes)
			const firstHistory = await history.mock.results[0]!.value
			expect(history.mock.calls[1]![2].maxReadBytes).toBe(
				8 * 1024 * 1024 - liveBytes - firstHistory.scannedBytes,
			)
			expect(remainingBudgets[1]).toBeLessThan(remainingBudgets[0]!)
			expect(metadata.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
			expect(metadata.incomplete).toBe(true)
			expect(metadata.continuations).toHaveLength(4)
			const runtime = { runId: live.runId, captureRunEvidence }
			for (const [i, hint] of metadata.continuations.entries()) {
				const page = await searchConversation(sessions, sessionId, hint.input, undefined, runtime)
				expect(page.matches.length).toBeGreaterThan(0)
				expect(
					page.matches.every((m) => m.text.startsWith(i % 2 === 0 ? 'DELTA' : 'in queue')),
				).toBe(true)
			}
			expect(
				(await live.store.readEvents()).filter((e) => e.type === 'tool_completed'),
			).toHaveLength(18)
		} finally {
			history.mockRestore()
		}
	})

	it('returns to the broad cursor after an empty focused scan without starting it again', async () => {
		const { sessions, sessionId } = await fixture()
		const { runId, path } = await transcript(sessions, sessionId, 'seed')
		await writeFile(
			join(path, 'transcript.jsonl'),
			`${[
				{ type: 'run_started', runId, seq: 1 },
				...Array.from({ length: 24 }, (_, i) => ({
					type: 'tool_completed',
					runId,
					seq: i + 2,
					result: `in queue ${i}`,
				})),
			]
				.map((event) => JSON.stringify(event))
				.join('\n')}\n`,
		)
		const search = vi.spyOn(conversationSearch, 'searchConversationTerms')
		try {
			const recall = createConversationEvidenceRecall(sessions, sessionId, () => {})
			const result = await recall({
				runId: generateRunId(),
				messages: [createUserMessage('in DELTA')],
				steps: [],
				prepared: {},
				stepNumber: 1,
			})
			expect(search.mock.calls.map((call) => call[2].terms)).toEqual([
				['in', 'DELTA'],
				['DELTA'],
				['in', 'DELTA'],
				['in', 'DELTA'],
			])
			const metadata = JSON.parse(result!.context!.split('\n')[1]!)
			expect(metadata.incomplete).toBe(true)
			expect(metadata.continuations).toHaveLength(1)
			const page = await searchConversation(sessions, sessionId, metadata.continuations[0].input)
			expect(page.matches.map((m) => m.text)).toEqual(
				Array.from({ length: 5 }, (_, i) => `in queue ${i + 15}`),
			)
		} finally {
			search.mockRestore()
		}
	})

	it('retains token matching when a model continues a host search by cursor alone', async () => {
		const { sessions, sessionId } = await fixture()
		const { runId, path } = await transcript(sessions, sessionId, 'seed')
		const texts = ['in A', 'in B', 'in C', 'in D', 'in E', 'Packing information', 'in FINAL']
		await writeFile(
			join(path, 'transcript.jsonl'),
			`${[
				{ type: 'run_started', runId, seq: 1 },
				...texts.map((result, i) => ({ type: 'tool_completed', runId, seq: i + 2, result })),
			]
				.map((e) => JSON.stringify(e))
				.join('\n')}\n`,
		)
		const request = {
			terms: ['in'],
			matchMode: 'token' as const,
			excludeRunId: generateRunId(),
			maxReadBytes: 8 * 1024 * 1024,
		}
		const first = await searchConversationTerms(sessions, sessionId, request)
		expect(first.matches).toHaveLength(5)
		const cursor = first.nextCursor!
		await expect(
			searchConversationTerms(sessions, sessionId, { ...request, matchMode: 'literal', cursor }),
		).rejects.toThrow('matching mode changed')
		const final = await searchConversation(sessions, sessionId, { cursor })
		expect(final.matches.map((m) => m.text)).toEqual(['in FINAL'])
		expect(final.nextCursor).toBeUndefined()
		expect(final.incomplete).toBe(false)
		expect(final.guidance).toContain('complete Unicode')
	})

	it('refuses oversized live handles before retaining a bridge cursor', async () => {
		const { sessions, sessionId } = await fixture()
		for (const cursor of ['', 'x'.repeat(4097)])
			expect(() =>
				retainLiveConversationSearch(sessions, sessionId, generateRunId(), ['DELTA'], cursor),
			).toThrow('Invalid live evidence continuation')
	})

	it('continues host multi-term recall by cursor alone with its original exclusion and scope', async () => {
		const { sessions, sessionId } = await fixture()
		const { runId, path } = await transcript(sessions, sessionId, 'seed')
		const events = Array.from({ length: 10 }, (_, i) => ({
			type: 'tool_completed',
			runId,
			seq: i + 2,
			result: `DELTA-${i}`,
		}))
		await writeFile(
			join(path, 'transcript.jsonl'),
			`${[{ type: 'run_started', runId, seq: 1 }, ...events].map((e) => JSON.stringify(e)).join('\n')}\n`,
		)
		const first = await searchConversationTerms(sessions, sessionId, {
			terms: ['DELTA', 'code'],
			excludeRunId: generateRunId(),
			maxReadBytes: 8 * 1024 * 1024,
		})
		expect(first.matches).toHaveLength(5)
		const options = { cursor: first.nextCursor! }
		const [second, repeated] = await Promise.all([
			searchConversation(sessions, sessionId, options),
			searchConversation(sessions, sessionId, options),
		])
		expect(second.matches).toEqual(repeated.matches)
		expect(second.matches.map((m) => m.text)).toEqual(
			Array.from({ length: 5 }, (_, i) => `DELTA-${i + 5}`),
		)
		await expect(
			searchConversation(sessions, await startConversation(sessions), options),
		).rejects.toThrow('scope')
		await expect(
			searchConversation(sessions, sessionId, { ...options, query: 'DELTA' }),
		).rejects.toThrow('query')
		await expect(
			searchConversation(sessions, sessionId, { ...options, caseSensitive: true }),
		).rejects.toThrow('case sensitivity')
		await expect(searchConversation(sessions, sessionId, {})).rejects.toThrow('literal query')
		await releaseConversationEvidence(sessions, sessionId)
		await expect(searchConversation(sessions, sessionId, options)).rejects.toThrow('expired')
	})

	it('passes a live recall continuation into the same writer after new appends without action replay', async () => {
		const { cwd, sessions, sessionId } = await fixture()
		const runId = generateRunId()
		const owner = { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId }
		const store = new RunDiskStore({ baseDir: join(cwd, 'writer') })
		const runDir = await store.initRun(runId)
		await writeFile(
			join(runDir, 'run.json'),
			JSON.stringify({ id: runId, metadata: { scope: owner } }),
		)
		await store.appendEvent({ type: 'run_started', runId, seq: 1 } as RunEvent)
		for (let i = 0; i < 10; i++)
			await store.appendEvent({
				type: 'tool_completed',
				runId,
				seq: i + 2,
				toolName: 'read',
				toolUseId: `read-${i}`,
				result: `DELTA code ${i}`,
				isError: false,
			} as RunEvent)
		const captureRunEvidence = (maxReadBytes?: number) =>
			store.captureTextEvidence(owner, maxReadBytes)
		// An omission in a separate historical scan must not taint this healthy
		// live writer's continuation merely because the overall recall is incomplete.
		const unavailablePast = await transcript(sessions, sessionId, 'unrelated historical record')
		await writeFile(join(unavailablePast.path, 'transcript.jsonl'), 'damaged historical record\n')
		const recall = createConversationEvidenceRecall(sessions, sessionId, () => {})
		const result = await recall({
			runId,
			messages: [createUserMessage('DELTA code')],
			steps: [],
			prepared: {},
			stepNumber: 1,
			captureRunEvidence,
		})
		const metadata = JSON.parse(result!.context!.split('\n')[1]!)
		const hint = metadata.continuations[0]
		expect(hint.toolName).toBe('search_conversation')
		await store.appendEvent({
			type: 'tool_completed',
			runId,
			seq: 12,
			toolName: 'read',
			toolUseId: 'later',
			result: 'DELTA later',
			isError: false,
		} as RunEvent)
		const page = await searchConversation(sessions, sessionId, hint.input, undefined, {
			runId,
			captureRunEvidence,
		})
		expect(page.matches.map((m) => m.text)).toEqual(['DELTA code 1', 'DELTA code 0'])
		expect(page.matches.some((m) => m.text.includes('later'))).toBe(false)
		expect(page.incomplete).toBe(false)
		const rejected = await searchConversation(sessions, sessionId, hint.input)
		expect(rejected.matches).toHaveLength(0)
		expect(rejected.unavailableRuns).toBe(1)
		expect((await store.readEvents()).filter((e) => e.type === 'tool_completed')).toHaveLength(11)
	})

	it('retains an earlier live preview omission after continuing beyond the automatic page limit', async () => {
		const { cwd, sessions, sessionId } = await fixture()
		const runId = generateRunId()
		const owner = { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId }
		const store = new RunDiskStore({ baseDir: join(cwd, 'writer') })
		const runDir = await store.initRun(runId)
		await writeFile(
			join(runDir, 'run.json'),
			JSON.stringify({ id: runId, metadata: { scope: owner } }),
		)
		await store.appendEvent({ type: 'run_started', runId, seq: 1 } as RunEvent)
		for (let i = 0; i < 10; i++)
			await store.appendEvent({
				type: 'tool_completed',
				runId,
				seq: i + 2,
				toolName: 'read',
				toolUseId: `read-${i}`,
				result: `DELTA code ${i}`,
				isError: false,
			} as RunEvent)
		await store.appendEvent({
			type: 'tool_completed',
			runId,
			seq: 12,
			toolName: 'read',
			toolUseId: 'preview',
			result: 'Unretained observation excerpt.',
			isError: false,
			outputTruncated: true,
		} as RunEvent)
		const captureRunEvidence = (maxReadBytes?: number) =>
			store.captureTextEvidence(owner, maxReadBytes)
		const recall = createConversationEvidenceRecall(sessions, sessionId, () => {})
		const result = await recall({
			runId,
			messages: [createUserMessage('DELTA')],
			steps: [],
			prepared: {},
			stepNumber: 1,
			captureRunEvidence,
		})
		const metadata = JSON.parse(result!.context!.split('\n')[1]!)
		expect(metadata.incomplete).toBe(true)
		const input = metadata.continuations[0].input
		const page = await searchConversation(sessions, sessionId, input, undefined, {
			runId,
			captureRunEvidence,
		})
		expect(page.matches.map((m) => m.text)).toEqual(['DELTA code 1', 'DELTA code 0'])
		expect(page.nextCursor).toBeUndefined()
		expect(page.unavailableRuns).toBe(0) // no new missing record on this page
		expect(page.incomplete).toBe(true) // earlier omitted bytes still prevent an exhaustive claim
		expect(page.guidance).toContain('Some recorded evidence was omitted or unavailable')
		const repeated = await searchConversation(sessions, sessionId, input, undefined, {
			runId,
			captureRunEvidence,
		})
		expect(repeated.incomplete).toBe(true)
	})

	it('reaches runs beyond the initial 100-entry page without duplicates or false completeness', async () => {
		const { sessions, sessionId } = await fixture()
		for (let i = 0; i < 120; i++) await transcript(sessions, sessionId, 'unrelated observation')
		const runs = join(
			new CliPathBuilder(sessions.root).sessionDir(sessions.projectId, sessionId),
			'runs',
		)
		const directory = await opendir(runs)
		const ids: string[] = []
		for await (const entry of directory) ids.push(entry.name)
		const target = ids[119]
		if (!target) throw new Error('Fixture target missing')
		await writeFile(
			join(runs, target, 'transcript.jsonl'),
			`${[
				{ type: 'run_started', runId: target, seq: 1 },
				{ type: 'message_completed', runId: target, seq: 2, content: 'DELTA ORIGINAL-471' },
			]
				.map((e) => JSON.stringify(e))
				.join('\n')}\n`,
		)
		const first = await searchConversation(sessions, sessionId, { query: 'DELTA' })
		expect(first.matches).toHaveLength(0)
		expect(first.scannedRuns).toBe(100)
		expect(first.incomplete).toBe(true)
		expect(first.nextCursor).toBeDefined()
		const options = { query: 'DELTA', cursor: first.nextCursor }
		const [second, repeated] = await Promise.all([
			searchConversation(sessions, sessionId, options),
			searchConversation(sessions, sessionId, options),
		])
		expect(second).toEqual(repeated)
		expect(second.scannedRuns).toBe(20)
		expect(second.matches).toMatchObject([{ runId: target, text: 'DELTA ORIGINAL-471' }])
		expect(second.incomplete).toBe(false)
		expect(second.nextCursor).toBeUndefined()
		const exact = await readConversationEvidence(sessions, sessionId, {
			runId: target,
			seq: 2,
			part: 0,
		})
		expect(exact.text).toBe('DELTA ORIGINAL-471')
		await releaseConversationEvidence(sessions, sessionId)
		await expect(searchConversation(sessions, sessionId, options)).rejects.toThrow('expired')
	})

	it('recalls an active observation past 512 nontext events within the live page allowance', async () => {
		const { cwd, sessions, sessionId } = await fixture()
		const runId = generateRunId()
		const scope = { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId }
		const store = new RunDiskStore({ baseDir: join(cwd, 'evidence') })
		const runDir = await store.initRun(runId)
		await writeFile(join(runDir, 'run.json'), JSON.stringify({ id: runId, metadata: { scope } }))
		let seq = 0
		const append = async (event: Record<string, unknown>) =>
			store.appendEvent({ ...event, runId, seq: ++seq } as RunEvent)
		await append({ type: 'run_started' })
		await append({
			type: 'tool_completed',
			toolName: 'read',
			toolUseId: 'observe-once',
			result: 'DELTA original receipt: ORIGINAL-471',
			isError: false,
		})
		for (let i = 0; i < 512; i++) await append({ type: 'iteration_started', iteration: i })
		const captureRunEvidence = vi.fn((maxReadBytes?: number) =>
			store.captureTextEvidence(scope, maxReadBytes),
		)
		const recall = createConversationEvidenceRecall(sessions, sessionId, () => {})
		const context = await recall({
			runId,
			messages: [createUserMessage('What was the original DELTA receipt?')],
			stepNumber: 100,
			prepared: {},
			steps: [],
			captureRunEvidence,
		})
		expect(context?.context).toContain('ORIGINAL-471')
		expect(context?.context).toContain('"retained":"full"')
		expect(captureRunEvidence).toHaveBeenCalledTimes(1)
		expect((await store.readEvents()).filter((e) => e.type === 'tool_completed')).toHaveLength(1)
	})

	it.each(['source', 'page', 'budget'])(
		'rejects an invalid live %s without falling back to disk history',
		async (invalid) => {
			const { sessions, sessionId } = await fixture()
			await transcript(sessions, sessionId, 'DELTA prior evidence')
			const runId = generateRunId()
			const owner = { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId }
			const foreign = { ...owner, sessionId: generateRunId() }
			const search = vi.fn(async () => ({
				scope: invalid === 'page' ? foreign : owner,
				matches: [],
				nextCursor: null,
				scannedBytes: invalid === 'budget' ? 9 * 1024 * 1024 : 0,
				indexedRecords: 0,
				cacheHit: false,
				incomplete: false,
				unavailable: [],
			}))
			const source: RunTextEvidenceSource = {
				scope: invalid === 'source' ? foreign : owner,
				search,
				read: async () => {
					throw new Error('Unexpected read')
				},
			}
			const recall = createConversationEvidenceRecall(sessions, sessionId, () => {})
			await expect(
				recall({
					runId,
					messages: [createUserMessage('DELTA')],
					stepNumber: 2,
					prepared: {},
					steps: [],
					captureRunEvidence: async () => source,
				}),
			).rejects.toThrow(invalid === 'budget' ? 'retrieval bounds' : 'different owner')
			expect(search).toHaveBeenCalledTimes(invalid === 'source' ? 0 : 1)
		},
	)

	it('shares term cursors only with the exact term set and invocation exclusion', async () => {
		const { sessions, sessionId } = await fixture()
		for (let i = 0; i < 7; i++) await transcript(sessions, sessionId, `DELTA receipt ${i}`)
		const excluded = generateRunId()
		const input = {
			terms: ['DELTA', 'receipt'],
			excludeRunId: excluded,
			maxReadBytes: 8 * 1024 * 1024,
		}
		const first = await searchConversationTerms(sessions, sessionId, input)
		expect(first.nextCursor).toBeDefined()
		const cursor = first.nextCursor!
		await expect(
			searchConversation(sessions, sessionId, { query: 'DELTA', cursor }),
		).rejects.toThrow('query')
		await expect(
			searchConversationTerms(sessions, sessionId, { ...input, terms: ['DELTA'], cursor }),
		).rejects.toThrow('query')
		await expect(
			searchConversationTerms(sessions, sessionId, {
				...input,
				excludeRunId: generateRunId(),
				cursor,
			}),
		).rejects.toThrow('query')
		const next = await searchConversationTerms(sessions, sessionId, {
			...input,
			terms: ['receipt', 'DELTA', 'DELTA'],
			cursor,
		})
		expect(next.matches.length).toBeGreaterThan(0)
	})

	it('omits active invocation and refuses late ownership changes in automatic recall', async () => {
		const { sessions, sessionId } = await fixture()
		const old = await transcript(sessions, sessionId, 'DELTA history ORIGINAL-17')
		const active = await transcript(sessions, sessionId, 'DELTA active CURRENT-92')
		const assertOwner = vi.fn()
		const recall = createConversationEvidenceRecall(sessions, sessionId, assertOwner)
		const ctx = {
			runId: active.runId,
			messages: [createUserMessage('DELTA')],
			stepNumber: 1,
			prepared: {},
			steps: [],
		}
		const first = await recall(ctx)
		expect(first?.context).toContain('ORIGINAL-17')
		expect(first?.context).not.toContain('CURRENT-92')
		expect(first?.context).toContain('"retained":"preview"')
		expect(first?.context).toContain(old.runId)
		assertOwner
			.mockReset()
			.mockImplementationOnce(() => {})
			.mockImplementation(() => {
				throw new Error('Ownership changed')
			})
		await expect(recall(ctx)).rejects.toThrow('Ownership changed')
	})

	it('revalidates indexed bytes on each recall and never falls back from a damaged source', async () => {
		const { sessions, sessionId } = await fixture()
		const { runId, path } = await transcript(sessions, sessionId, 'DELTA ORIGINAL-17')
		await writeFile(
			join(path, 'run.json'),
			JSON.stringify({
				id: runId,
				status: 'completed',
				metadata: {
					scope: { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId },
				},
			}),
		)
		await writeFile(
			join(path, 'transcript.jsonl'),
			`${[
				{ type: 'run_started', runId, seq: 1 },
				{
					type: 'tool_completed',
					runId,
					seq: 2,
					toolName: 'read',
					toolUseId: 'observation',
					isError: false,
					result: 'DELTA ORIGINAL-17',
				},
			]
				.map((event) => JSON.stringify(event))
				.join('\n')}\n`,
		)
		const recall = createConversationEvidenceRecall(sessions, sessionId, () => {})
		const ctx = {
			runId: generateRunId(),
			messages: [createUserMessage('DELTA')],
			stepNumber: 1,
			prepared: {},
			steps: [],
		}
		expect((await recall(ctx))?.context).toContain('ORIGINAL-17')
		await writeFile(join(path, 'transcript.jsonl'), 'not a valid transcript\n')
		const unavailable = await recall(ctx)
		expect(unavailable?.context).toContain('"incomplete":true')
		expect(unavailable?.context).not.toContain('ORIGINAL-17')
	})

	it('continues past matching announcements to the original observation without claiming absence', async () => {
		const { sessions, sessionId } = await fixture()
		const { runId, path } = await transcript(sessions, sessionId, 'seed')
		await writeFile(
			join(path, 'run.json'),
			JSON.stringify({
				id: runId,
				status: 'completed',
				metadata: {
					scope: { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId },
				},
			}),
		)
		await writeFile(
			join(path, 'transcript.jsonl'),
			`${[
				{ type: 'run_started', runId, seq: 1 },
				...[2, 3, 4].map((seq) => ({
					type: 'message_completed',
					runId,
					seq,
					content: 'Searching the earlier DELTA observation.',
				})),
				{
					type: 'tool_completed',
					runId,
					seq: 5,
					toolName: 'read',
					toolUseId: 'original',
					isError: false,
					result: 'DELTA receipt: ORIGINAL-471',
				},
			]
				.map((event) => JSON.stringify(event))
				.join('\n')}\n`,
		)
		const first = await searchConversation(sessions, sessionId, { query: 'DELTA', runId })
		expect(first.matches).toHaveLength(3)
		expect(first.matches.every((match) => match.source === 'message_completed')).toBe(true)
		expect(first.incomplete).toBe(true)
		expect(first.nextCursor).toBeDefined()
		expect(first.guidance).toContain('an announcement is not the original observation')
		const next = await searchConversation(sessions, sessionId, {
			query: 'DELTA',
			cursor: first.nextCursor,
		})
		expect(next.matches).toHaveLength(1)
		expect(next.matches[0]).toMatchObject({ seq: 5, toolName: 'read', retained: 'full' })
		const original = await readConversationEvidence(sessions, sessionId, next.matches[0]!)
		expect(original.text).toBe('DELTA receipt: ORIGINAL-471')
		expect(next.incomplete).toBe(false)
		expect(next.guidance).not.toContain('More recorded history remains')
	})

	it('bounds indexed JSON excerpts and paginates message history alongside tool output', async () => {
		const { sessions, sessionId } = await fixture()
		const runId = generateRunId()
		const path = new CliPathBuilder(sessions.root).runDir(sessions.projectId, sessionId, runId)
		await mkdir(path, { recursive: true })
		await writeFile(
			join(path, 'run.json'),
			JSON.stringify({
				id: runId,
				status: 'completed',
				metadata: {
					scope: { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId },
				},
			}),
		)
		const events = [
			{ type: 'run_started', runId, seq: 1 },
			...Array.from({ length: 8 }, (_, index) => ({
				runId,
				seq: index + 2,
				...(index < 3
					? {
							type: 'tool_completed',
							toolName: '\u0001'.repeat(index === 0 ? 500 : 40),
							toolUseId: `original-${index}`,
							isError: false,
							result: '\u0001'.repeat(5000),
						}
					: { type: 'message_completed', content: '\u0001'.repeat(5000) }),
			})),
		]
		await writeFile(
			join(path, 'transcript.jsonl'),
			`${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
		)
		let cursor: string | undefined
		const sequences = []
		do {
			const page = await searchConversation(sessions, sessionId, {
				query: '\u0001',
				limit: 20,
				cursor,
			})
			expect(Buffer.byteLength(JSON.stringify(page.matches))).toBeLessThanOrEqual(12_000)
			expect(page.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
			expect(page.guidance).toContain('case-insensitive')
			for (const match of page.matches) if (match.seq === 2) expect(match.toolName).toBeUndefined()
			sequences.push(...page.matches.map((match) => match.seq))
			cursor = page.nextCursor
		} while (cursor)
		expect([...new Set(sequences)]).toEqual([2, 3, 4, 5, 6, 7, 8, 9])
		expect(sequences.length).toBeGreaterThan(8)
	})

	it('recovers tool evidence from a real SDK transcript containing a tool-only assistant turn', async () => {
		const { cwd, sessions, sessionId } = await fixture()
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'original_evidence',
				description: 'Return the immutable source identifier.',
				inputSchema: mcpJsonSchemaToZod({
					type: 'object',
					properties: {},
					additionalProperties: false,
				}),
				category: 'custom',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async () => ({ success: true, output: 'REAL-SDK-IDENTIFIER-72af99' }),
			}),
		)
		const events: RunEvent[] = []
		for await (const event of query({
			provider: new MockLLMProvider({
				turns: [
					{
						toolCalls: [{ id: 'c1', name: 'original_evidence', args: {} }],
						finishReason: 'tool_calls',
					},
					{ text: 'Inspected the identifier.' },
				],
			}),
			tools,
			runConfig: { model: 'mock', timeoutMs: 10_000, tokenBudget: 100_000, maxIterations: 3 },
			agentId: 'evidence-test',
			agentName: 'Evidence test',
			messages: [createUserMessage('Inspect the source.')],
			workingDirectory: cwd,
			pathBuilder: new CliPathBuilder(sessions.root),
			sessionId,
			topicId: sessions.topicId,
			projectId: sessions.projectId,
			tenantId: sessions.tenantId,
			resumeHandler: async () => ({ action: 'continue' }),
		}))
			events.push(event)
		expect(events.some((event) => event.type === 'run_completed')).toBe(true)
		expect(
			events.some((event) => event.type === 'message_completed' && event.content === undefined),
		).toBe(true)
		await replaceConversation(sessions, sessionId, [
			createUserMessage('Compacted summary without identifier.'),
		])
		const restarted = await openSessions(cwd)
		const result = await searchConversation(restarted, sessionId, {
			query: 'REAL-SDK-IDENTIFIER-72af99',
		})
		expect(result.matches).toEqual([
			expect.objectContaining({ source: 'tool_completed', text: 'REAL-SDK-IDENTIFIER-72af99' }),
		])
		expect(result.incomplete).toBe(false)
		expect(result.unavailableRuns).toBe(0)
	})

	it('recovers exact earlier tool output after compacted projection and restart', async () => {
		const { cwd, sessions, sessionId } = await fixture()
		await appendMessages(sessions, sessionId, [createUserMessage('inspect the old result')])
		const original = await transcript(
			sessions,
			sessionId,
			'The immutable identifier is ORIGINAL-72af99.',
		)
		await replaceConversation(sessions, sessionId, [
			createUserMessage('Compacted: inspected a result.'),
		])
		const restarted = await openSessions(cwd)
		expect(JSON.stringify(await loadConversation(restarted, sessionId))).not.toContain(
			'ORIGINAL-72af99',
		)
		const result = await searchConversation(restarted, sessionId, {
			query: 'ORIGINAL-72af99',
		})
		expect(result.matches).toEqual([
			{
				runId: original.runId,
				part: 0,
				seq: 2,
				source: 'tool_completed',
				text: 'The immutable identifier is ORIGINAL-72af99.',
			},
		])
		expect(result.incomplete).toBe(false)
	})

	it('does not read another session, project, tenant, or caller-selected path', async () => {
		const { sessions, sessionId } = await fixture()
		const other = await startConversation(sessions)
		const foreign = await transcript(sessions, other, 'PRIVATE-ID')
		expect(
			(
				await searchConversation(sessions, sessionId, {
					query: 'PRIVATE-ID',
					runId: foreign.runId,
				})
			).matches,
		).toEqual([])
		await expect(
			searchConversation(sessions, sessionId, {
				query: 'PRIVATE-ID',
				runId: '../secret',
			}),
		).rejects.toThrow()
		const second = await fixture()
		await expect(
			searchConversation(second.sessions, sessionId, { query: 'PRIVATE-ID' }),
		).rejects.toThrow()
		await expect(
			searchConversation(
				{ ...sessions, tenantId: 'foreign-tenant' as CliSessions['tenantId'] },
				sessionId,
				{ query: 'PRIVATE-ID' },
			),
		).rejects.toThrow()
	})

	it('rejects directory and file symlinks into another conversation', async () => {
		const { sessions, sessionId } = await fixture()
		const other = await startConversation(sessions)
		const foreign = await transcript(sessions, other, 'PRIVATE-ID')
		const root = join(
			new CliPathBuilder(sessions.root).sessionDir(sessions.projectId, sessionId),
			'runs',
		)
		await mkdir(root, { recursive: true })
		await symlink(foreign.path, join(root, foreign.runId), 'dir')
		const runId = generateRunId()
		await mkdir(join(root, runId))
		await symlink(join(foreign.path, 'transcript.jsonl'), join(root, runId, 'transcript.jsonl'))
		const result = await searchConversation(sessions, sessionId, {
			query: 'PRIVATE-ID',
		})
		expect(result.matches).toEqual([])
		expect(result.unavailableRuns).toBe(2)
	})

	it('does not claim absent original evidence when the retained tool output was truncated', async () => {
		const { sessions, sessionId } = await fixture()
		const { runId, path } = await transcript(sessions, sessionId, 'retained preview')
		await writeFile(
			join(path, 'transcript.jsonl'),
			`${[
				{ type: 'run_started', runId, seq: 1 },
				{
					type: 'tool_completed',
					runId,
					seq: 2,
					result: 'retained preview',
					outputTruncated: true,
					outputSpillPath: '/not-read-by-evidence-search',
				},
			]
				.map((event) => JSON.stringify(event))
				.join('\n')}\n`,
		)
		const result = await searchConversation(sessions, sessionId, {
			query: 'identifier omitted by the output budget',
		})
		expect(result.matches).toEqual([])
		expect(result.scannedRuns).toBe(1)
		expect(result.unavailableRuns).toBe(0)
		expect(result.incomplete).toBe(true)
	})

	it('bounds excerpts, admits large records, and reports corrupt evidence honestly', async () => {
		const { sessions, sessionId } = await fixture()
		await transcript(sessions, sessionId, `${'x'.repeat(10_000)}TARGET${'y'.repeat(10_000)}`)
		await transcript(sessions, sessionId, 'TARGET invalid tail', '{broken}\n')
		await transcript(sessions, sessionId, `TARGET${'x'.repeat(2 * 1024 * 1024)}`)
		const result = await searchConversation(sessions, sessionId, {
			query: 'TARGET',
			limit: 20,
		})
		expect(result.matches).toHaveLength(2)
		expect(result.matches[0]?.text.length).toBeLessThan(600)
		expect(result.unavailableRuns).toBe(1)
		expect(result.incomplete).toBe(true)
		expect(result.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
		await expect(
			searchConversation(sessions, sessionId, { query: 'TARGET', limit: 21 }),
		).rejects.toThrow()
	})
})

it('recovers evidence past 8 MiB with bounded pages and no repeated matches', async () => {
	const { sessions, sessionId } = await fixture()
	const { runId, path } = await transcript(sessions, sessionId, 'seed')
	const events: unknown[] = [{ type: 'run_started', runId, seq: 1 }]
	for (let index = 0; index < 12; index++)
		events.push({
			type: 'tool_completed',
			runId,
			seq: index + 2,
			result: 'x'.repeat(1024 * 1024) + (index === 11 ? 'HIDDEN-ORIGINAL-91' : ''),
		})
	await writeFile(
		join(path, 'transcript.jsonl'),
		events.map((e) => JSON.stringify(e)).join('\n') + '\n',
	)
	const first = await searchConversation(sessions, sessionId, {
		query: 'HIDDEN-ORIGINAL-91',
		runId,
	})
	expect(first.matches).toEqual([])
	expect(first.unavailableRuns).toBe(0)
	expect(first.incomplete).toBe(true)
	expect(first.nextCursor).toHaveLength(48)
	expect(first.guidance).toContain('More recorded history remains')
	expect(first.guidance).toContain('nextCursor as cursor')
	const second = await searchConversation(sessions, sessionId, {
		query: 'HIDDEN-ORIGINAL-91',
		cursor: first.nextCursor,
	})
	expect(second.matches).toHaveLength(1)
	expect(second.matches[0]).toMatchObject({ runId, seq: 13 })
	expect(second.incomplete).toBe(false)
	expect(second.nextCursor).toBeUndefined()
	expect(second.guidance).not.toContain('More recorded history remains')
	for (const page of [first, second]) expect(page.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
})
it('paginates several matches within one compaction event without duplicates', async () => {
	const { sessions, sessionId } = await fixture()
	const { runId, path } = await transcript(sessions, sessionId, 'seed')
	await writeFile(
		join(path, 'transcript.jsonl'),
		[
			{ type: 'run_started', runId, seq: 1 },
			{
				type: 'compaction_shed',
				runId,
				seq: 2,
				messages: Array.from({ length: 7 }, (_, i) => ({ role: 'tool', content: `TARGET-${i}` })),
			},
			{ type: 'run_completed', runId, seq: 3 },
		]
			.map((e) => JSON.stringify(e))
			.join('\n') + '\n',
	)
	let cursor: string | undefined
	const texts: string[] = []
	for (let page = 0; page < 5; page++) {
		const result = await searchConversation(sessions, sessionId, {
			query: 'TARGET',
			limit: 2,
			...(cursor ? { cursor } : { runId }),
		})
		texts.push(...result.matches.map((m) => m.text))
		cursor = result.nextCursor
		if (!cursor) {
			expect(result.incomplete).toBe(false)
			break
		}
	}
	expect(cursor).toBeUndefined()
	expect(texts).toEqual(Array.from({ length: 7 }, (_, i) => `TARGET-${i}`))
})
it('binds cursors to the original query, conversation and stable file snapshot', async () => {
	const { sessions, sessionId } = await fixture()
	const { runId, path } = await transcript(sessions, sessionId, 'seed')
	const content =
		[
			{ type: 'run_started', runId, seq: 1 },
			{ type: 'tool_completed', runId, seq: 2, result: 'TARGET-one' },
			{ type: 'tool_completed', runId, seq: 3, result: 'TARGET-two' },
		]
			.map((e) => JSON.stringify(e))
			.join('\n') + '\n'
	await writeFile(join(path, 'transcript.jsonl'), content)
	const first = await searchConversation(sessions, sessionId, { query: 'TARGET', runId, limit: 1 })
	expect(first.nextCursor).toBeDefined()
	const repeatedScope = await searchConversation(sessions, sessionId, {
		query: 'TARGET',
		runId,
		cursor: first.nextCursor,
	})
	expect(repeatedScope.matches.map((m) => m.text)).toEqual(['TARGET-two'])
	await expect(
		searchConversation(sessions, sessionId, {
			query: 'TARGET',
			runId: generateRunId(),
			cursor: first.nextCursor,
		}),
	).rejects.toThrow('continuation scope')
	await expect(
		searchConversation(sessions, sessionId, { query: 'different', cursor: first.nextCursor }),
	).rejects.toThrow('scope or query')
	const other = await startConversation(sessions)
	await expect(
		searchConversation(sessions, other, { query: 'TARGET', cursor: first.nextCursor }),
	).rejects.toThrow('scope or query')
	await expect(
		searchConversation(sessions, sessionId, { query: 'TARGET', cursor: 'forged' }),
	).rejects.toThrow('unavailable')
	await writeFile(join(path, 'transcript.jsonl'), content + '{}\n')
	const changed = await searchConversation(sessions, sessionId, {
		query: 'TARGET',
		cursor: first.nextCursor,
	})
	expect(changed.matches).toEqual([])
	expect(changed.incomplete).toBe(true)
	expect(changed.unavailableRuns).toBe(1)
})
it('propagates cancellation instead of returning an empty search result', async () => {
	const { sessions, sessionId } = await fixture()
	const controller = new AbortController()
	controller.abort(new Error('stop evidence scan'))
	await expect(
		searchConversation(sessions, sessionId, { query: 'TARGET' }, controller.signal),
	).rejects.toThrow('stop evidence scan')
})

it('forwards a search caller cancellation into live capture before scanning text', async () => {
	const { sessions, sessionId } = await fixture()
	const { runId } = await transcript(sessions, sessionId, 'ORCHID')
	const controller = new AbortController()
	let received: AbortSignal | undefined
	const captureRunEvidence = vi.fn(async (_maxReadBytes?: number, signal?: AbortSignal) => {
		received = signal
		controller.abort(new Error('cancel this search'))
		signal?.throwIfAborted()
		return undefined
	})
	await expect(
		searchConversation(sessions, sessionId, { query: 'ORCHID', runId }, controller.signal, {
			runId,
			captureRunEvidence,
		}),
	).rejects.toThrow('cancel this search')
	expect(captureRunEvidence).toHaveBeenCalledTimes(1)
	expect(received).toBe(controller.signal)
})

it('refuses an oversized single record rather than allocating without bound', async () => {
	const { sessions, sessionId } = await fixture()
	const { runId } = await transcript(sessions, sessionId, 'TARGET' + 'x'.repeat(4 * 1024 * 1024))
	const result = await searchConversation(sessions, sessionId, { query: 'TARGET', runId })
	expect(result.matches).toEqual([])
	expect(result.unavailableRuns).toBe(1)
	expect(result.incomplete).toBe(true)
	expect(result.nextCursor).toBeUndefined()
})

it('reads every retained character without splitting surrogate pairs or re-running a tool', async () => {
	const { sessions, sessionId } = await fixture()
	const content = 'x'.repeat(5999) + '😀' + 'tail'.repeat(1900)
	const { runId } = await transcript(sessions, sessionId, content)
	let cursor: string | undefined
	let actual = ''
	for (let i = 0; i < 5; i++) {
		const page = await readConversationEvidence(sessions, sessionId, { runId, seq: 2, cursor })
		expect(page.text.length).toBeLessThanOrEqual(6000)
		expect(page.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
		expect(page.offset).toBe(actual.length)
		expect(page.retainedPreview).toBe(false)
		actual += page.text
		cursor = page.nextCursor
		if (page.complete) break
	}
	expect(cursor).toBeUndefined()
	expect(actual).toBe(content)
	// Durable address also works without the old process-local cursor.
	expect((await readConversationEvidence(sessions, sessionId, { runId, seq: 2 })).offset).toBe(0)
})

it('addresses individual shed messages and refuses a foreign scope or changed cursor address', async () => {
	const { sessions, sessionId } = await fixture()
	const { runId, path } = await transcript(sessions, sessionId, 'seed')
	await writeFile(
		join(path, 'transcript.jsonl'),
		[
			{ type: 'run_started', runId, seq: 1 },
			{
				type: 'compaction_shed',
				runId,
				seq: 2,
				messages: [
					{ role: 'tool', content: 'first' },
					{ role: 'tool', content: 'second'.repeat(1500) },
				],
			},
		]
			.map((e) => JSON.stringify(e))
			.join('\n') + '\n',
	)
	const matches = await searchConversation(sessions, sessionId, { runId, query: 'second' })
	expect(matches.matches[0]?.part).toBe(1)
	const page = await readConversationEvidence(sessions, sessionId, { runId, seq: 2, part: 1 })
	expect(page.text).toBe('second'.repeat(1000))
	expect(page.nextCursor).toBeDefined()
	await expect(
		readConversationEvidence(sessions, sessionId, {
			runId,
			seq: 2,
			part: 0,
			cursor: page.nextCursor,
		}),
	).rejects.toThrow('scope or query')
	const other = await startConversation(sessions)
	await expect(
		readConversationEvidence(sessions, other, { runId, seq: 2, part: 1, cursor: page.nextCursor }),
	).rejects.toThrow('scope or query')
	await expect(readConversationEvidence(sessions, other, { runId, seq: 2 })).rejects.toThrow()
	await expect(readConversationEvidence(sessions, sessionId, { runId, seq: 3 })).rejects.toThrow(
		'no retained textual part',
	)
})

it('continues a full read beyond the per-call scan budget and marks retained previews', async () => {
	const { sessions, sessionId } = await fixture()
	const { runId, path } = await transcript(sessions, sessionId, 'seed')
	await writeFile(
		join(path, 'transcript.jsonl'),
		[
			{ type: 'run_started', runId, seq: 1 },
			...Array.from({ length: 10 }, (_, i) => ({
				type: 'tool_completed',
				runId,
				seq: i + 2,
				result: 'x'.repeat(1024 * 1024),
			})),
			{ type: 'tool_completed', runId, seq: 12, result: 'retained preview', outputTruncated: true },
		]
			.map((e) => JSON.stringify(e))
			.join('\n') + '\n',
	)
	const first = await readConversationEvidence(sessions, sessionId, { runId, seq: 12 })
	expect(first.text).toBe('')
	expect(first.complete).toBe(false)
	expect(first.nextCursor).toBeDefined()
	const second = await readConversationEvidence(sessions, sessionId, {
		runId,
		seq: 12,
		cursor: first.nextCursor,
	})
	expect(second.text).toBe('retained preview')
	expect(second.complete).toBe(true)
	expect(second.retainedPreview).toBe(true)
})

it('ignores case in legacy transcripts, allows exact case and binds it to pagination', async () => {
	const { sessions, sessionId } = await fixture()
	const { runId } = await transcript(sessions, sessionId, 'Destination of DELTA: α🦉 a.*[B]')
	const page = await searchConversation(sessions, sessionId, { query: 'destination', runId })
	expect(page.matches).toHaveLength(1)
	expect(page.matches[0]!.text).toContain('Destination of DELTA')
	expect(
		(
			await searchConversation(sessions, sessionId, {
				query: 'destination',
				runId,
				caseSensitive: true,
			})
		).matches,
	).toHaveLength(0)
	expect(
		(await searchConversation(sessions, sessionId, { query: 'A.*[b]', runId })).matches,
	).toHaveLength(1)
	expect(
		(await searchConversation(sessions, sessionId, { query: 'A.*[c]', runId })).matches,
	).toHaveLength(0)
	await transcript(sessions, sessionId, 'Destination of DELTA: second')
	const first = await searchConversation(sessions, sessionId, { query: 'destination', limit: 1 })
	expect(first.nextCursor).toBeDefined()
	await expect(
		searchConversation(sessions, sessionId, {
			query: 'destination',
			cursor: first.nextCursor,
			caseSensitive: true,
		}),
	).rejects.toThrow('case sensitivity changed')
	const second = await searchConversation(sessions, sessionId, {
		query: 'destination',
		cursor: first.nextCursor,
	})
	expect(second.matches).toHaveLength(1)
	expect(second.matches[0]!.runId).not.toBe(first.matches[0]!.runId)
})
