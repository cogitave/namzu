import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	MockLLMProvider,
	RunDiskStore,
	type RunEvent,
	type RunTextEvidenceSource,
	type SessionId,
	ToolRegistry,
	createUserMessage,
	defineTool,
	generateRunId,
	mcpJsonSchemaToZod,
	query,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	readConversationEvidence,
	searchConversation,
	searchConversationTerms,
} from './conversation-search.js'
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
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

async function fixture() {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-conversation-search-'))
	dirs.push(cwd)
	const sessions = await openSessions(cwd)
	const sessionId = await startConversation(sessions)
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

describe('bounded original conversation evidence', () => {
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
		expect(await recall(ctx)).toBeUndefined()
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
