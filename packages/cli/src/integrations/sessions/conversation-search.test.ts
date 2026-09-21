import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
	SessionEvidenceSourceOptions,
	SessionId,
	SessionTextEvidenceSearchOptions,
	SessionTextEvidenceSource,
	ToolContext,
	TurnId,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The search and read tools adapt the SDK's session-log evidence reader to
 * the model: one reader per conversation, sealed cursors, cached addresses,
 * and the live turn's own snapshot when the caller is that turn. The reader
 * itself (chain verification, spills, excerpts) is the SDK's and is proved
 * there; here it is a small in-memory stand-in so the adapter's own rules are
 * what fails when they break.
 */

interface Passage {
	readonly seq: number
	readonly part: number
	readonly source: string
	readonly text: string
	readonly toolName?: string
	readonly isError?: boolean
}

const opened: SessionEvidenceSourceOptions[] = []
let passages: Passage[] = []

function fakeSource(
	scope: SessionTextEvidenceSource['scope'],
	all: () => readonly Passage[],
): SessionTextEvidenceSource {
	return {
		scope,
		async search(options: SessionTextEvidenceSearchOptions = {}) {
			const excluded = new Set(options.excludeSuccessfulTools ?? [])
			const needles = options.terms ?? (options.query !== undefined ? [options.query] : [])
			const caseSensitive = options.caseSensitive ?? true
			const fold = (text: string) => (caseSensitive ? text : text.toLowerCase())
			let excludedToolResults = 0
			const candidates = all().filter((passage) => {
				if (options.seq !== undefined && passage.seq !== options.seq) return false
				if (options.part !== undefined && passage.part !== options.part) return false
				if (passage.toolName && passage.isError === false && excluded.has(passage.toolName)) {
					excludedToolResults++
					return false
				}
				return (
					needles.length === 0 ||
					needles.some((needle) => fold(passage.text).includes(fold(needle)))
				)
			})
			const start = options.cursor ? Number(options.cursor) : 0
			const limit = options.limit ?? 5
			const page = candidates.slice(start, start + limit)
			const next = start + limit < candidates.length ? String(start + limit) : null
			return {
				scope,
				matches: page.map((passage) => ({
					address: `${passage.seq}:${passage.part}`,
					seq: passage.seq,
					part: passage.part,
					source: passage.source,
					toolName: passage.toolName,
					isError: passage.isError,
					retained: 'full' as const,
					excerpt: passage.text.slice(0, 512),
					excerptComplete: passage.text.length <= 512,
					byteOffset: 0,
					characterOffset: 0,
				})),
				nextCursor: next,
				scannedBytes: 100,
				indexedRecords: candidates.length,
				cacheHit: false,
				incomplete: false,
				unavailable: [],
				...(excludedToolResults ? { excludedToolResults } : {}),
			}
		},
		async read(options) {
			const [seq, part] = options.address.split(':').map(Number)
			const passage = all().find((p) => p.seq === seq && p.part === part)
			if (!passage) throw new Error('unknown address')
			return {
				scope,
				seq: passage.seq,
				part: passage.part,
				source: passage.source,
				toolName: passage.toolName,
				isError: passage.isError,
				retained: 'full' as const,
				text: passage.text,
				byteOffset: 0,
				nextByteOffset: null,
				totalBytes: Buffer.byteLength(passage.text),
				scannedBytes: 50,
				characterOffset: 0,
				totalChars: passage.text.length,
			}
		},
	}
}

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		createSessionTextEvidenceSource: (options: SessionEvidenceSourceOptions) => {
			opened.push(options)
			return fakeSource(options.scope, () => passages)
		},
		// The recall step is the kernel's; the adapter under test is `retrieve`.
		createEvidenceRecallStep: (options: unknown) => options,
		refineEvidenceRecallTerms: () => undefined,
	}
})

const { openSessions, startConversation, conversationLogPath } = await import('./store.js')
const {
	buildConversationReadTool,
	buildConversationSearchTool,
	readConversationEvidence,
	releaseConversationEvidence,
	searchConversation,
} = await import('./conversation-search.js')
const { createConversationEvidenceRecall } = await import('./evidence-recall.js')

type Sessions = Awaited<ReturnType<typeof openSessions>>

async function fixture(): Promise<{ sessions: Sessions; sessionId: SessionId }> {
	const sessions = await openSessions(mkdtempSync(join(tmpdir(), 'namzu-search-')), {
		stateRoot: mkdtempSync(join(tmpdir(), 'namzu-search-home-')),
	})
	return { sessions, sessionId: await startConversation(sessions) }
}

afterEach(() => {
	opened.length = 0
	passages = []
})

describe('search_conversation', () => {
	it('reads this conversation’s log as a snapshot, scoped to its project', async () => {
		const { sessions, sessionId } = await fixture()
		passages = [
			{
				seq: 4,
				part: 0,
				source: 'tool_completed',
				text: 'ORCHID-7',
				toolName: 'bash',
				isError: false,
			},
		]

		const result = await searchConversation(sessions, sessionId, { query: 'orchid' })

		expect(result.matches).toEqual([
			expect.objectContaining({ seq: 4, part: 0, text: 'ORCHID-7', toolName: 'bash' }),
		])
		expect(opened).toEqual([
			expect.objectContaining({
				scope: { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId },
				logPath: conversationLogPath(sessions, sessionId),
				consistency: 'snapshot',
			}),
		])
		await releaseConversationEvidence(sessions, sessionId)
	})

	it('excludes successful retrieval outputs by default and includes them on request', async () => {
		const { sessions, sessionId } = await fixture()
		passages = [
			{
				seq: 2,
				part: 0,
				source: 'tool_completed',
				text: 'DELTA original',
				toolName: 'bash',
				isError: false,
			},
			{
				seq: 5,
				part: 0,
				source: 'tool_completed',
				text: 'DELTA quoted',
				toolName: 'search_conversation',
				isError: false,
			},
		]

		const plain = await searchConversation(sessions, sessionId, { query: 'DELTA' })
		const inclusive = await searchConversation(sessions, sessionId, {
			query: 'DELTA',
			includeRetrievalResults: true,
		})

		expect(plain.matches.map((match) => match.seq)).toEqual([2])
		expect(plain.excludedToolResults).toBe(1)
		expect(inclusive.matches.map((match) => match.seq)).toEqual([2, 5])
		await releaseConversationEvidence(sessions, sessionId)
	})

	it('seals its cursor to the query and the conversation', async () => {
		const { sessions, sessionId } = await fixture()
		passages = Array.from({ length: 8 }, (_, index) => ({
			seq: index + 2,
			part: 0,
			source: 'message_completed',
			text: `TARGET ${index}`,
		}))

		const first = await searchConversation(sessions, sessionId, { query: 'TARGET', limit: 1 })
		expect(first.matches).toHaveLength(1)
		expect(first.nextCursor).toMatch(/^[0-9a-f]{48}$/)
		const cursor = first.nextCursor as string

		const second = await searchConversation(sessions, sessionId, { cursor })
		expect(second.matches[0]?.seq).toBeGreaterThan(first.matches[0]?.seq ?? 0)
		await expect(
			searchConversation(sessions, sessionId, { query: 'different', cursor }),
		).rejects.toThrow(/does not match/)
		const other = await startConversation(sessions)
		await expect(searchConversation(sessions, other, { cursor })).rejects.toThrow(/does not match/)
		await expect(searchConversation(sessions, sessionId, { cursor: 'forged' })).rejects.toThrow(
			/expired/,
		)
		await releaseConversationEvidence(sessions, sessionId)
		await expect(searchConversation(sessions, sessionId, { cursor })).rejects.toThrow(/expired/)
	})

	it('narrows a new search to one turn through the reader’s scope', async () => {
		const { sessions, sessionId } = await fixture()
		passages = [{ seq: 3, part: 0, source: 'message_completed', text: 'NEEDLE' }]
		const turnId = '019a0000-0000-7000-8000-000000000001'

		await searchConversation(sessions, sessionId, { query: 'NEEDLE', turnId })

		expect(opened[0]?.scope).toMatchObject({ sessionId, turnId })
		await releaseConversationEvidence(sessions, sessionId)
	})

	it('refuses a conversation of another project', async () => {
		const { sessions } = await fixture()
		const other = await openSessions(mkdtempSync(join(tmpdir(), 'namzu-search-other-')), {
			stateRoot: sessions.root,
		})
		const foreign = await startConversation(other)

		await expect(searchConversation(sessions, foreign, { query: 'x' })).rejects.toThrow(
			/outside the current scope/,
		)
		expect(opened).toEqual([])
	})

	it('prefers the calling turn’s live snapshot and binds its cursor to it', async () => {
		const { sessions, sessionId } = await fixture()
		passages = Array.from({ length: 4 }, (_, index) => ({
			seq: index + 2,
			part: 0,
			source: 'message_completed',
			text: `LIVE ${index}`,
		}))
		const scope = { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId }
		const capture = vi.fn(async () => fakeSource(scope, () => passages))
		const active = {
			sessionId,
			turnId: '019a0000-0000-7000-8000-000000000002' as TurnId,
			captureSessionEvidence: capture,
		}

		const first = await searchConversation(
			sessions,
			sessionId,
			{ query: 'LIVE', limit: 1 },
			undefined,
			active,
		)

		expect(capture).toHaveBeenCalled()
		expect(opened).toEqual([])
		await expect(
			searchConversation(sessions, sessionId, { cursor: first.nextCursor }),
		).rejects.toThrow(/live evidence owner/)
		await releaseConversationEvidence(sessions, sessionId)
	})
})

describe('read_conversation', () => {
	it('reads the exact text at a searched address, and again after the cache is released', async () => {
		const { sessions, sessionId } = await fixture()
		const text = 'the complete original output'
		passages = [
			{ seq: 7, part: 1, source: 'tool_completed', text, toolName: 'bash', isError: false },
		]
		const found = await searchConversation(sessions, sessionId, { query: 'original' })
		const match = found.matches[0]
		if (!match) throw new Error('fixture expected one match')

		const cached = await readConversationEvidence(sessions, sessionId, {
			seq: match.seq,
			part: match.part,
		})
		await releaseConversationEvidence(sessions, sessionId)
		const cold = await readConversationEvidence(sessions, sessionId, { seq: 7, part: 1 })

		for (const page of [cached, cold]) {
			expect(page).toMatchObject({ seq: 7, part: 1, text, complete: true, toolName: 'bash' })
		}
		await expect(readConversationEvidence(sessions, sessionId, { seq: 99 })).rejects.toThrow(
			/no retained textual part/,
		)
	})

	it('refuses an invalid address before it opens a reader', async () => {
		const { sessions, sessionId } = await fixture()

		await expect(readConversationEvidence(sessions, sessionId, { seq: 0 })).rejects.toThrow(
			/positive record sequence/,
		)
		expect(opened).toEqual([])
	})
})

describe('the model-facing tools', () => {
	it('answer through the tool call’s own conversation and fail closed', async () => {
		const { sessions, sessionId } = await fixture()
		passages = [{ seq: 2, part: 0, source: 'message_completed', text: 'TOOLS' }]
		const resolveScope = () => ({ sessions, sessionId })
		const context = { abortSignal: new AbortController().signal } as unknown as ToolContext

		const search = await buildConversationSearchTool(resolveScope).execute(
			{ query: 'TOOLS' },
			context,
		)
		const read = await buildConversationReadTool(resolveScope).execute({ seq: 2 }, context)
		const invalid = await buildConversationSearchTool(resolveScope).execute(
			{ limit: 99, query: 'x' },
			context,
		)

		expect(search.success).toBe(true)
		expect(JSON.parse(search.output).matches[0].text).toBe('TOOLS')
		expect(read.success).toBe(true)
		expect(JSON.parse(read.output).text).toBe('TOOLS')
		expect(invalid.success).toBe(false)
		await releaseConversationEvidence(sessions, sessionId)
	})
})

describe('automatic recall', () => {
	it('retrieves candidates from the conversation and hands back sealed continuations', async () => {
		const { sessions, sessionId } = await fixture()
		passages = Array.from({ length: 12 }, (_, index) => ({
			seq: index + 2,
			part: 0,
			source: 'tool_completed',
			text: `RECALL token ${index}`,
			toolName: 'bash',
			isError: false,
		}))
		const owners: (string | undefined)[] = []
		const recall = createConversationEvidenceRecall(sessions, sessionId, (turnId) => {
			owners.push(turnId)
		}) as unknown as {
			retrieve: (request: {
				terms: readonly string[]
				maxReadBytes: number
				maxCandidates: number
				signal: AbortSignal
			}) => Promise<{
				candidates: { seq: number; scope: unknown }[]
				incomplete: boolean
				continuations: { toolName: string; input: { cursor: string } }[]
			}>
		}

		const batch = await recall.retrieve({
			terms: ['RECALL'],
			maxReadBytes: 8 * 1024 * 1024,
			maxCandidates: 24,
			signal: new AbortController().signal,
		})

		expect(batch.candidates.length).toBeGreaterThan(0)
		expect(batch.candidates[0]?.scope).toEqual({
			tenantId: sessions.tenantId,
			projectId: sessions.projectId,
			sessionId,
		})
		expect(owners.length).toBeGreaterThan(0)
		if (batch.continuations.length > 0) {
			const next = await searchConversation(
				sessions,
				sessionId,
				batch.continuations[0]?.input ?? {},
			)
			expect(next.matches.length).toBeGreaterThan(0)
		}
		await releaseConversationEvidence(sessions, sessionId)
	})
})
