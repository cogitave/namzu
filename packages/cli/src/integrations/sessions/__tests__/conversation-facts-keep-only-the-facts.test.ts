import { mkdtempSync } from 'node:fs'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type SessionId,
	SessionLogIntegrityError,
	type SessionRecord,
	type SessionRecordDraft,
	accountBoundPayload,
	generateCheckpointId,
	generateMessageId,
	generateSessionId,
	generateTurnId,
	readSessionLog,
} from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { pullRequestOfRecords } from '../../github/pull-request.js'
import { ConversationFactsFold, conversationFactsOf } from '../conversation-facts.js'
import {
	closeSessions,
	conversationLogPath,
	openConversationLog,
	openSessions,
	readConversationFacts,
	readConversationRecords,
	startConversation,
} from '../store.js'

/**
 * `readConversationFacts` answers what its callers ask without keeping the
 * log. The answers are compared with the ones the previous implementation
 * (every record kept, then scanned) gives on the same records, field by field
 * and query by query; what it holds is counted by the records it is handed.
 */
let cwd: string
let stateRoot: string
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), 'namzu-facts-'))
	stateRoot = mkdtempSync(join(tmpdir(), 'namzu-facts-home-'))
})
afterEach(() => {
	removeTempDir(cwd)
	removeTempDir(stateRoot)
})

type Sessions = Awaited<ReturnType<typeof openSessions>>

/** The previous implementation, verbatim in what it answers. */
function oracle(records: readonly SessionRecord[]) {
	const first = records[0]
	if (first === undefined || first.type !== 'session_started') return null
	let title: string | undefined
	let named = false
	let archived = false
	let active: { turnId: string; paused: boolean } | undefined
	for (const record of records) {
		switch (record.type) {
			case 'session_updated':
				if (record.title !== undefined) {
					title = record.title
					named = record.titleSource === 'named' && record.title.length > 0
				}
				if (record.archived !== undefined) archived = record.archived
				break
			case 'turn_started':
				active = { turnId: record.turnId, paused: false }
				break
			case 'turn_paused':
				if (active?.turnId === record.turnId) active = { ...active, paused: true }
				break
			case 'turn_resuming':
				if (active?.turnId === record.turnId) active = { ...active, paused: false }
				break
			case 'turn_completed':
			case 'turn_failed':
				if (active?.turnId === record.turnId) active = undefined
				break
		}
	}
	return {
		started: first,
		...(title !== undefined ? { title } : {}),
		named,
		archived,
		createdAt: first.ts,
		updatedAt: records.at(-1)?.ts ?? first.ts,
		...(active ? { activeTurn: active } : {}),
	}
}

function pendingOracle(records: readonly SessionRecord[], turnId: string): Map<string, string> {
	const pending = new Map<string, string>()
	for (const record of records) {
		if (record.type === 'decision_requested' && record.turnId === turnId)
			pending.set(record.decisionId, record.request.type)
		if (record.type === 'decision_resolved' || record.type === 'decision_expired')
			pending.delete(record.decisionId)
	}
	return pending
}

async function appendAll(s: Sessions, id: SessionId, drafts: readonly SessionRecordDraft[]) {
	const log = openConversationLog(s, id)
	const lease = await log.claim({ holder: 'facts-test', ttlMs: 60_000 })
	if (!lease) throw new Error('claim failed')
	try {
		for (const draft of drafts) await log.append(lease, draft)
	} finally {
		await log.release(lease)
	}
}

const BEGIN = { type: 'begin' } as unknown as SessionRecordDraft
const turnConfig = { model: 'm-1', tokenBudget: 1, timeoutMs: 1 }

async function beginTurn(s: Sessions, id: SessionId, turnId = generateTurnId()) {
	const log = openConversationLog(s, id)
	const lease = await log.claim({ holder: 'facts-test', ttlMs: 60_000 })
	if (!lease) throw new Error('claim failed')
	try {
		await log.beginTurn(lease, { turnId, userMessageId: generateMessageId(), config: turnConfig })
	} finally {
		await log.release(lease)
	}
	return turnId
}

const failedDraft = (turnId: string) =>
	({
		type: 'turn_failed',
		turnId,
		error: 'x',
		failure: { code: 'c', message: 'm', retryable: false },
		settlement: {
			status: 'failed',
			iterations: 0,
			usage: {
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
			cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
			durationMs: 0,
			resultSource: 'model',
			abandonedTaskIds: [],
			abandonedJobIds: [],
		},
	}) as unknown as SessionRecordDraft

/** A conversation exercising every fact: titles, archive, pauses, decisions, accounts, a pull request. */
async function busyConversation(s: Sessions, options: { close: boolean }) {
	const id = await startConversation(s)
	const first = generateTurnId()
	const checkpointId = generateCheckpointId()
	const log = openConversationLog(s, id)
	const lease = await log.claim({ holder: 'facts-test', ttlMs: 60_000 })
	if (!lease) throw new Error('claim failed')
	const drafts: SessionRecordDraft[] = [
		{ type: 'session_updated', title: 'Derived', titleSource: 'derived' } as SessionRecordDraft,
		BEGIN,
		{
			type: 'turn_paused',
			turnId: first,
			reason: 'provider',
			checkpointId,
			providerError: { kind: 'throttle', providerId: 'p-1' },
		} as SessionRecordDraft,
		{
			type: 'decision_requested',
			turnId: first,
			decisionId: 'd-open',
			checkpointId,
			request: { type: 'tool_review', checkpointId },
		} as unknown as SessionRecordDraft,
		{
			type: 'decision_requested',
			turnId: first,
			decisionId: 'd-done',
			checkpointId,
			request: { type: 'user_question', checkpointId },
		} as unknown as SessionRecordDraft,
		{
			type: 'decision_expired',
			turnId: first,
			decisionId: 'd-done',
		} as unknown as SessionRecordDraft,
		{
			type: 'turn_resuming',
			turnId: first,
			fromCheckpointId: checkpointId,
		} as SessionRecordDraft,
		{
			type: 'turn_paused',
			turnId: first,
			reason: 'handoff',
			checkpointId: generateCheckpointId(),
			handoff: { kind: 'human-required', reason: 'sign in' },
		} as SessionRecordDraft,
		{
			type: 'session_updated',
			title: 'Named by a person',
			titleSource: 'named',
		} as SessionRecordDraft,
		{
			type: 'session_updated',
			externalRefs: {
				add: [
					{
						protocol: 'pull-request',
						kind: 'context',
						externalId: 'https://github.com/acme/widgets/pull/12',
					},
				],
			},
		} as SessionRecordDraft,
		{
			type: 'session_updated',
			harness: {
				kind: 'dispatch-prepared',
				model: 'dispatch-model',
				operationId: 'op',
				turnId: first,
				promptId: generateMessageId(),
				digest: 'a'.repeat(64),
			},
		} as unknown as SessionRecordDraft,
		accountBoundPayload('openai:work' as never, 'openai', 'user_switch') as SessionRecordDraft,
		accountBoundPayload('openai:home' as never, 'openai', 'user_switch') as SessionRecordDraft,
		accountBoundPayload(
			'anthropic:default' as never,
			'anthropic',
			'user_switch',
		) as SessionRecordDraft,
		{ type: 'session_updated', archived: true } as SessionRecordDraft,
		{ type: 'session_updated', archived: false } as SessionRecordDraft,
	]
	try {
		for (const draft of drafts) {
			if (draft === BEGIN) {
				await log.beginTurn(lease, {
					turnId: first,
					userMessageId: generateMessageId(),
					config: turnConfig,
				})
			} else await log.append(lease, draft)
		}
		if (options.close) await log.append(lease, failedDraft(first))
	} finally {
		await log.release(lease)
	}
	return { id, first }
}

describe('readConversationFacts', () => {
	it('answers null for a conversation with no log, as before', async () => {
		const s = await openSessions(cwd, { stateRoot })
		try {
			expect(await readConversationFacts(s, generateSessionId())).toBeNull()
			expect(await readConversationFacts(s, generateSessionId(), 'tolerant')).toBeNull()
			expect(await readConversationRecords(s, generateSessionId())).toBeNull()
		} finally {
			closeSessions(s)
		}
	})

	it('answers a freshly started conversation, an empty one, as the records say', async () => {
		const s = await openSessions(cwd, { stateRoot })
		try {
			const id = await startConversation(s)
			const records = (await readSessionLog(conversationLogPath(s, id))).entries.map(
				(e) => e.record,
			)
			const expected = oracle(records)
			for (const mode of ['strict', 'tolerant'] as const) {
				const facts = await readConversationFacts(s, id, mode)
				expect(facts).toMatchObject({ sessionId: id, ...expected })
				expect(facts?.activeTurn).toBeUndefined()
			}
		} finally {
			closeSessions(s)
		}
	})

	it.each(['strict', 'tolerant'] as const)(
		'answers every fact and query as the full scan of the records does (%s)',
		async (mode) => {
			const s = await openSessions(cwd, { stateRoot })
			try {
				const { id, first } = await busyConversation(s, { close: true })
				const second = await beginTurn(s, id) // a turn left running
				const records = (await readSessionLog(conversationLogPath(s, id))).entries.map(
					(entry) => entry.record,
				)
				const expected = oracle(records)
				const facts = await readConversationFacts(s, id, mode)
				expect(facts).toMatchObject({ sessionId: id, ...expected })
				expect(facts?.activeTurn).toEqual({ turnId: second, paused: false })
				expect(facts?.title).toBe('Named by a person')
				expect(facts?.named).toBe(true)
				expect(facts?.archived).toBe(false)
				expect(facts?.latestDispatchModel).toBe('dispatch-model')
				expect(facts?.pullRequest).toEqual(pullRequestOfRecords(records))
				expect(facts?.startedTurn(first)).toEqual({ model: 'm-1' })
				expect(facts?.startedTurn('nope')).toBeUndefined()
				const latest = [...records]
					.reverse()
					.find((r) => r.type === 'turn_paused' && r.turnId === first)
				expect(facts?.latestPause(first)).toEqual(latest)
				expect(facts?.pausedForHandoff(first)).toBe(true)
				expect(facts?.wasResumed(first)).toBe(true)
				expect(facts?.wasResumed(second)).toBe(false)
				expect(facts?.pendingDecisions(first)).toEqual(pendingOracle(records, first))
				expect([...(facts?.pendingDecisions(first) ?? [])]).toEqual([['d-open', 'tool_review']])
				expect(facts?.accountBinding('openai')).toBe('openai:home')
				expect(facts?.accountBinding('anthropic')).toBe('anthropic:default')
				expect(facts?.accountBinding('other')).toBeUndefined()
				// The whole-log read and the lean one agree on all of it.
				const whole = await readConversationRecords(s, id, mode)
				expect(whole?.records).toHaveLength(records.length)
				expect(conversationFactsOf(id, records)).toMatchObject({ ...expected })
				expect(whole).toMatchObject({ ...expected })
			} finally {
				closeSessions(s)
			}
		},
	)

	it('follows a conversation that grows, a settled turn and a resumed session', async () => {
		const s = await openSessions(cwd, { stateRoot })
		try {
			const { id, first } = await busyConversation(s, { close: false })
			expect((await readConversationFacts(s, id))?.activeTurn).toEqual({
				turnId: first,
				paused: true,
			})
			await appendAll(s, id, [
				{
					type: 'turn_resuming',
					turnId: first,
					fromCheckpointId: generateCheckpointId(),
				} as SessionRecordDraft,
			])
			expect((await readConversationFacts(s, id))?.activeTurn).toEqual({
				turnId: first,
				paused: false,
			})
			await appendAll(s, id, [
				{
					type: 'session_updated',
					title: 'Later title',
					titleSource: 'derived',
				} as SessionRecordDraft,
				{
					type: 'turn_failed',
					turnId: first,
					error: 'x',
					failure: { code: 'c', message: 'm', retryable: false },
					settlement: {
						status: 'failed',
						iterations: 0,
						usage: {
							promptTokens: 0,
							completionTokens: 0,
							totalTokens: 0,
							cachedTokens: 0,
							cacheWriteTokens: 0,
						},
						cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
						durationMs: 0,
						resultSource: 'model',
						abandonedTaskIds: [],
						abandonedJobIds: [],
					},
				} as unknown as SessionRecordDraft,
			])
			const facts = await readConversationFacts(s, id)
			const records = (await readSessionLog(conversationLogPath(s, id))).entries.map(
				(e) => e.record,
			)
			expect(facts).toMatchObject({ ...oracle(records) })
			expect(facts?.activeTurn).toBeUndefined()
			expect(facts?.title).toBe('Later title')
			expect(facts?.named).toBe(false)
		} finally {
			closeSessions(s)
		}
	})
})

describe('the strict read of a conversation', () => {
	it('is refused by a log altered in the middle after this process read it, at the next read', async () => {
		const s = await openSessions(cwd, { stateRoot })
		try {
			const id = await startConversation(s)
			for (let i = 0; i < 30; i++) {
				await appendAll(s, id, [
					{
						type: 'session_updated',
						title: `title-${String(i).padStart(2, '0')}`,
					} as SessionRecordDraft,
				])
			}
			expect((await readConversationFacts(s, id))?.title).toBe('title-29')
			const file = conversationLogPath(s, id)
			await writeFile(file, (await readFile(file, 'utf8')).replace('title-10', 'title-1o'))
			await expect(readConversationFacts(s, id)).rejects.toBeInstanceOf(SessionLogIntegrityError)
			// Tolerant reads what precedes the break (the altered record itself is a valid record), as before.
			const tolerant = await readConversationFacts(s, id, 'tolerant')
			expect(tolerant?.title).toBe('title-1o')
		} finally {
			closeSessions(s)
		}
	})

	it('is refused by a record appended with a wrong shape and a consistent hash', async () => {
		const s = await openSessions(cwd, { stateRoot })
		try {
			const id = await startConversation(s)
			await readConversationFacts(s, id)
			const log = openConversationLog(s, id)
			const head = (await log.head())?.pointer
			if (!head) throw new Error('no head')
			const line = `${JSON.stringify({
				v: 1,
				id: crypto.randomUUID(),
				sessionId: id,
				seq: head.seq + 1,
				ts: new Date(0).toISOString(),
				prev: head,
				gen: 1,
				type: 'session_updated',
				title: 5,
			})}\n`
			await appendFile(conversationLogPath(s, id), line)
			await expect(readConversationFacts(s, id)).rejects.toBeInstanceOf(SessionLogIntegrityError)
		} finally {
			closeSessions(s)
		}
	})

	it('starts again when the log was replaced or cut back', async () => {
		const s = await openSessions(cwd, { stateRoot })
		try {
			const id = await startConversation(s)
			await appendAll(s, id, [{ type: 'session_updated', title: 'kept' } as SessionRecordDraft])
			await appendAll(s, id, [{ type: 'session_updated', title: 'cut' } as SessionRecordDraft])
			expect((await readConversationFacts(s, id))?.title).toBe('cut')
			const file = conversationLogPath(s, id)
			const lines = (await readFile(file, 'utf8')).split('\n')
			await writeFile(file, `${lines.slice(0, 2).join('\n')}\n`)
			expect((await readConversationFacts(s, id))?.title).toBe('kept')
		} finally {
			closeSessions(s)
		}
	})
})

describe('what a read of a long conversation holds and parses', () => {
	it('folds each record once, then only the new ones, and keeps none', async () => {
		const apply = vi.spyOn(ConversationFactsFold.prototype, 'apply')
		const folded: { first: number; unchanged: number; appended: number }[] = []
		try {
			for (const n of [20, 80]) {
				const dir = await mkdtemp(join(tmpdir(), 'namzu-facts-n-'))
				try {
					const s = await openSessions(dir, { stateRoot })
					const id = await startConversation(s)
					await appendAll(
						s,
						id,
						Array.from(
							{ length: n },
							(_, i) => ({ type: 'session_updated', title: `t${i}` }) as SessionRecordDraft,
						),
					)
					apply.mockClear()
					const first = await readConversationFacts(s, id)
					expect(first?.title).toBe(`t${n - 1}`)
					expect(Object.keys(first ?? {})).not.toContain('records')
					const afterFirst = apply.mock.calls.length
					await readConversationFacts(s, id)
					const afterUnchanged = apply.mock.calls.length
					await appendAll(s, id, [{ type: 'session_updated', title: 'new' } as SessionRecordDraft])
					const after = await readConversationFacts(s, id)
					expect(after?.title).toBe('new')
					folded.push({
						first: afterFirst,
						unchanged: afterUnchanged - afterFirst,
						appended: apply.mock.calls.length - afterUnchanged,
					})
					closeSessions(s)
				} finally {
					await rm(dir, { recursive: true, force: true })
				}
			}
		} finally {
			apply.mockRestore()
		}
		const [small, large] = folded as [(typeof folded)[number], (typeof folded)[number]]
		// The first read folds the whole log: four times the records, four times the work.
		expect(small.first).toBe(21)
		expect(large.first).toBe(81)
		// A later read folds what was appended, however long the log is.
		expect(small.unchanged).toBe(0)
		expect(large.unchanged).toBe(0)
		expect(small.appended).toBe(1)
		expect(large.appended).toBe(1)
	})
})
