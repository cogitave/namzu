import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatSessionLogLine, recordSha256 } from '../../../session/log-hash.js'
import { fixtureUuid } from '../../../test-support/ids.js'
import type { SessionId } from '../../../types/ids/index.js'
import { parseSessionRecord } from '../../../types/session/records.js'
import type { EvidenceQuery } from '../fts.js'
import type { SessionIndex } from '../index.js'

export const FIXTURES = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../../__fixtures__/session-log',
)

/** The slug every fixture is filed under: `slugForCwd('/work/fixture')`. */
export const SLUG = '-work-fixture'

export const TOP_LEVEL_FIXTURES = readdirSync(FIXTURES)
	.filter((name) => name.endsWith('.jsonl'))
	.sort()

export function sessionIdOf(text: string): SessionId {
	return (JSON.parse(text.slice(0, text.indexOf('\n'))) as { sessionId: SessionId }).sessionId
}

/**
 * A home holding every fixture under `projects/-work-fixture/`, each renamed
 * to `<session-id>.jsonl` as the layout files it, and the child-session
 * fixture with its `subagents/` tree. Returns the fixture name of each log.
 */
export function homeWithFixtures(home: string): Map<SessionId, string> {
	const project = join(home, 'projects', SLUG)
	mkdirSync(project, { recursive: true })
	const names = new Map<SessionId, string>()
	for (const name of TOP_LEVEL_FIXTURES) {
		const text = readFileSync(join(FIXTURES, name), 'utf8')
		const id = sessionIdOf(text)
		writeFileSync(join(project, `${id}.jsonl`), text)
		names.set(id, name)
	}
	cpSync(join(FIXTURES, 'child-sessions'), project, { recursive: true })
	return names
}

const EPOCH = Date.UTC(2026, 8, 21, 12, 0, 0)

/**
 * A valid log of `turns` prompt-and-answer turns, built through the same
 * line format a writer uses, so the chain is real. `shed`, when it returns
 * messages for a turn, adds a `compaction_shed` of them after the answer.
 */
export function syntheticLog(
	label: string,
	turns: number,
	answer: (turn: number) => string = (turn) => `Answer ${turn} for ${label}: the needle is here.`,
	shed?: (turn: number) => unknown[] | undefined,
): { sessionId: SessionId; text: string } {
	const sessionId = fixtureUuid(`synthetic:${label}`) as SessionId
	const lines: string[] = []
	let offset = 0
	let prev: { seq: number; offset: number; length: number; sha256: string } | null = null
	const append = (body: Record<string, unknown> & { type: string; turnId?: string }) => {
		const seq = lines.length + 1
		const record = parseSessionRecord({
			v: 1,
			id: fixtureUuid(`synthetic:${label}:record:${seq}`),
			sessionId,
			seq,
			ts: new Date(EPOCH + seq * 1000).toISOString(),
			prev,
			gen: 1,
			...body,
		})
		const line = formatSessionLogLine(record)
		const length = Buffer.byteLength(line)
		prev = { seq, offset, length, sha256: recordSha256(line) }
		offset += length
		lines.push(line)
	}
	append({
		type: 'session_started',
		projectId: fixtureUuid('synthetic:project'),
		cwd: '/work/fixture',
		agent: { id: 'synthetic', name: 'Synthetic' },
	})
	const usage = {
		promptTokens: 10,
		completionTokens: 5,
		totalTokens: 15,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
	for (let turn = 1; turn <= turns; turn++) {
		const turnId = fixtureUuid(`synthetic:${label}:turn:${turn}`)
		const prompt = fixtureUuid(`synthetic:${label}:prompt:${turn}`)
		const answerId = fixtureUuid(`synthetic:${label}:answer:${turn}`)
		append({
			type: 'turn_started',
			turnId,
			userMessageId: prompt,
			config: { model: 'synthetic', tokenBudget: 1000, timeoutMs: 1000 },
			origin: {
				protocol: 'a2a',
				externalSessionId: `ctx-${label}`,
				externalTurnId: `task-${label}-${turn}`,
			},
		})
		append({
			type: 'message',
			turnId,
			messageId: prompt,
			role: 'user',
			kind: 'prompt',
			content: { role: 'user', content: `Question ${turn} for ${label}` },
		})
		append({
			type: 'message_completed',
			turnId,
			iteration: 1,
			messageId: answerId,
			stopReason: 'end_turn',
			content: answer(turn),
		})
		const messages = shed?.(turn)
		if (messages !== undefined) {
			append({ type: 'compaction_shed', turnId, iteration: 1, messages, reason: 'threshold' })
		}
		append({
			type: 'turn_completed',
			turnId,
			result: `Answer ${turn}`,
			stopReason: 'end_turn',
			settlement: {
				status: 'completed',
				iterations: 1,
				usage,
				cost: { totalCost: 0.001, cacheDiscount: 0, unpricedTokens: 0 },
				durationMs: 10,
				resultSource: 'model',
				abandonedTaskIds: [],
				abandonedJobIds: [],
			},
		})
	}
	return { sessionId, text: lines.join('') }
}

export const QUERIES: readonly EvidenceQuery[] = [
	{ query: '' },
	{ query: 'files' },
	{ query: 'a.txt' },
	{ query: 'FILES', caseSensitive: false },
	{ query: 'PASSWORD', caseSensitive: false },
	{ query: 'hunter2' },
	{ terms: ['monorepo', 'Deleted', 'helper'] },
	{ terms: ['no problems', 'b.txt'], caseSensitive: false },
	{ query: 'build', matchMode: 'token' },
	{ terms: ['Started', 'audited'], matchMode: 'token', caseSensitive: false },
	{ query: 'xt' },
	{ query: 'repository' },
	{ query: 'nothing matches this' },
]

/** Every answer an index gives, in one comparable value. */
export async function dump(index: SessionIndex): Promise<unknown> {
	const sessions = await index.listSessions()
	const perSession: Record<string, unknown> = {}
	for (const session of sessions) {
		perSession[session.id] = {
			turns: await index.listTurns(session.id),
			children: await index.listChildren(session.id),
			decisions: await index.listPendingDecisions({ sessionId: session.id }),
			refs: await index.listExternalRefs(session.id),
			batches: await index.batches({ sessionId: session.id }),
		}
	}
	const search: unknown[] = []
	for (const query of QUERIES) search.push(await index.searchEvidence({ ...query, limit: 1000 }))
	return {
		sessions,
		roots: await index.listSessions({ rootsOnly: true }),
		unarchived: await index.listSessions({ includeArchived: false }),
		perSession,
		decisions: await index.listPendingDecisions(),
		batches: await index.batches(),
		search,
	}
}
