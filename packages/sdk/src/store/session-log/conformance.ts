/**
 * The session-log contract, as a suite a host runs against its own backend.
 *
 * A custom log (a database, an object store) is re-implemented against the
 * `SessionLog` interface and proved against this file. It holds the rules no
 * type can state: the chain verifies, a superseded lease cannot write, a
 * live lease is renewed only by the instance holding it (late or not), one
 * turn is active at a time and its state is `running`, `paused` or
 * `interrupted`, the fold applies compactions and replacements, a large body
 * spills and reads back, a torn tail is repaired on the record, and a flipped
 * byte is refused.
 *
 * Like `store/run/conformance.ts`, which it replaces, it takes `describe`,
 * `it` and `expect` as arguments: the SDK gains no test dependency, and a
 * caller can pass recording functions to run the suite as ordinary code
 * (which is how `conformance-fails-a-wrong-log.test.ts` shows a broken log
 * fails it).
 *
 * The assertions are public API: adding or tightening one raises
 * {@link SESSION_LOG_CONTRACT_VERSION} and ships in a major.
 */

import type { MessageId, SessionId, TurnId } from '../../types/ids/index.js'
import { isTurnInProgressError } from '../../types/session/turn.js'
import {
	generateCheckpointId,
	generateMessageId,
	generateProjectId,
	generateSessionId,
	generateTurnId,
} from '../../utils/id.js'
import type { SessionLog, SessionRecordDraft } from './core.js'
import type { SessionLease } from './lease.js'

/** The contract revision these assertions express. A host declares the one it wrote against, as a literal. */
export const SESSION_LOG_CONTRACT_VERSION = 2

/** Raw access to a backend's bytes, for the integrity cases. Omit it and those cases are skipped. */
export interface SessionLogTamper {
	/** The log's bytes as stored. */
	bytes(): Promise<Uint8Array>
	/** Replace the stored bytes wholesale. */
	overwrite(bytes: Uint8Array): Promise<void>
}

/** A log to test, over fresh storage. */
export interface SessionLogHandle {
	readonly log: SessionLog
	/** A second instance over the same storage, as another process would open it. */
	reopen(): SessionLog
	readonly tamper?: SessionLogTamper
	dispose?(): void | Promise<void>
}

export type MakeSessionLog = (sessionId: SessionId) => SessionLogHandle | Promise<SessionLogHandle>

/** The assertions the suite uses, and nothing more. */
export interface SessionLogAssertion {
	toBe(expected: unknown): void
	toEqual(expected: unknown): void
	toBeGreaterThan(expected: number): void
	toMatch(expected: RegExp): void
}

export interface SessionLogConformanceOptions {
	readonly describe: (name: string, body: () => void) => unknown
	readonly it: (name: string, body: () => Promise<void>) => unknown
	readonly expect: (actual: unknown) => SessionLogAssertion
	/** The contract revision the backend was written against, as a literal. */
	readonly contractVersion: number
	readonly makeLog: MakeSessionLog
	/** Names the backend in test output. */
	readonly label?: string
}

const NOW = 1_000_000
const TTL = 60_000
const LATER = NOW + TTL * 10

const USAGE = {
	promptTokens: 10,
	completionTokens: 5,
	totalTokens: 15,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}
const COST = { totalCost: 0.001, cacheDiscount: 0, unpricedTokens: 0 }
const CONFIG = { model: 'conformance-model', tokenBudget: 10_000, timeoutMs: 60_000 }

function started(): SessionRecordDraft {
	return {
		type: 'session_started',
		projectId: generateProjectId(),
		cwd: '/work/conformance',
		agent: { id: 'conformance', name: 'Conformance agent' },
	} as SessionRecordDraft
}

function message(
	turnId: TurnId,
	role: 'user' | 'assistant',
	text: string,
	id = generateMessageId(),
) {
	return {
		type: 'message',
		turnId,
		messageId: id,
		role,
		content: { role, content: text },
	} as SessionRecordDraft
}

function completed(
	turnId: TurnId,
	result: string,
	resultMessageId?: MessageId,
): SessionRecordDraft {
	return {
		type: 'turn_completed',
		turnId,
		result,
		stopReason: 'end_turn',
		settlement: {
			status: 'completed',
			iterations: 1,
			usage: USAGE,
			cost: COST,
			durationMs: 10,
			...(resultMessageId === undefined ? {} : { resultMessageId }),
			resultSource: 'model',
			abandonedTaskIds: [],
			abandonedJobIds: [],
		},
	} as SessionRecordDraft
}

function turnDraft(turnId: TurnId) {
	return { turnId, userMessageId: generateMessageId(), config: CONFIG }
}

async function rejection(call: () => Promise<unknown>): Promise<unknown> {
	try {
		await call()
	} catch (error) {
		return error
	}
	return new Error('expected a rejection, and the call resolved')
}

function nameOf(error: unknown): string {
	return error instanceof Error ? error.name : String(error)
}

/** Register the session-log contract against `options.makeLog`. */
export function defineSessionLogConformance(options: SessionLogConformanceOptions): void {
	const { describe, it, expect } = options
	const label = options.label ?? 'session log'

	async function withLog(body: (handle: SessionLogHandle, sessionId: SessionId) => Promise<void>) {
		const sessionId = generateSessionId()
		const handle = await options.makeLog(sessionId)
		try {
			await body(handle, sessionId)
		} finally {
			await handle.dispose?.()
		}
	}

	async function claimed(log: SessionLog, holder = 'writer-a', now = NOW): Promise<SessionLease> {
		const lease = await log.claim({ holder, ttlMs: TTL, now })
		if (lease === null) throw new Error(`${holder} could not claim a fresh session`)
		return lease
	}

	async function opened(log: SessionLog): Promise<SessionLease> {
		const lease = await claimed(log)
		await log.append(lease, started())
		return lease
	}

	describe(`${label}: session-log contract v${SESSION_LOG_CONTRACT_VERSION}`, () => {
		it('is tested against the contract revision it declares', async () => {
			expect(options.contractVersion).toBe(SESSION_LOG_CONTRACT_VERSION)
		})

		it('starts with session_started and chains every record to the one before', async () => {
			await withLog(async ({ log }, sessionId) => {
				const lease = await claimed(log)
				const early = await rejection(() =>
					log.append(lease, message(generateTurnId(), 'user', 'x')),
				)
				expect(early instanceof Error).toBe(true)
				await log.append(lease, started())
				const turnId = generateTurnId()
				await log.beginTurn(lease, turnDraft(turnId))
				const answer = generateMessageId()
				await log.append(lease, message(turnId, 'user', 'hello'))
				await log.append(lease, message(turnId, 'assistant', 'hi', answer))
				await log.append(lease, completed(turnId, 'hi', answer))
				const read = await log.readAll()
				expect(read.intact).toBe(true)
				expect(read.entries.map((e) => e.record.seq)).toEqual([1, 2, 3, 4, 5])
				expect(read.entries.map((e) => e.record.type)).toEqual([
					'session_started',
					'turn_started',
					'message',
					'message',
					'turn_completed',
				])
				for (let i = 1; i < read.entries.length; i++) {
					expect(read.entries[i]?.record.prev).toEqual(read.entries[i - 1]?.pointer)
				}
				expect(read.entries.every((e) => e.record.gen === lease.fence)).toBe(true)
				expect(read.entries.every((e) => e.record.sessionId === sessionId)).toBe(true)
				const head = await log.head()
				expect(head?.pointer).toEqual(read.entries.at(-1)?.pointer)
			})
		})

		it('lets one holder write at a time and refuses a superseded lease', async () => {
			await withLog(async (handle) => {
				const a = await opened(handle.log)
				const other = handle.reopen()
				expect(await other.claim({ holder: 'writer-b', ttlMs: TTL, now: NOW + 1 })).toBe(null)
				const b = await other.claim({ holder: 'writer-b', ttlMs: TTL, now: LATER })
				if (b === null) throw new Error('an expired lease could not be taken')
				expect(b.fence).toBeGreaterThan(a.fence)
				const refused = await rejection(() =>
					handle.log.append(a, { type: 'session_updated', title: 'late' } as SessionRecordDraft),
				)
				expect(nameOf(refused)).toBe('StaleSessionLeaseError')
				const entry = await other.append(b, {
					type: 'session_updated',
					title: 'taken over',
				} as SessionRecordDraft)
				expect(entry.record.gen).toBe(b.fence)
				await other.release(b)
				const afterRelease = await rejection(() =>
					other.append(b, { type: 'session_updated', title: 'x' } as SessionRecordDraft),
				)
				expect(nameOf(afterRelease)).toBe('StaleSessionLeaseError')
				const read = await other.readAll()
				expect(read.intact).toBe(true)
				expect(read.entries.length).toBe(2)
			})
		})

		it('does not let a second instance take a live lease under the same holder name', async () => {
			await withLog(async (handle) => {
				const a = await opened(handle.log)
				const turnId = generateTurnId()
				await handle.log.beginTurn(a, turnDraft(turnId))
				// The holder name is evidence, not authority: only the instance that
				// holds the lease renews it.
				const twin = handle.reopen()
				expect(await twin.claim({ holder: 'writer-a', ttlMs: TTL, now: NOW + 1 })).toBe(null)
				expect((await handle.log.activeTurn({ now: NOW + 1 }))?.state).toBe('running')
				const entry = await handle.log.append(a, message(turnId, 'user', 'still mine'))
				expect(entry.record.gen).toBe(a.fence)
			})
		})

		it('keeps a late renewal on its fence, and its turn running, when nobody took over', async () => {
			await withLog(async ({ log }) => {
				const a = await opened(log)
				const turnId = generateTurnId()
				await log.beginTurn(a, turnDraft(turnId))
				const renewed = await log.claim({ holder: 'writer-a', ttlMs: TTL, now: LATER })
				if (renewed === null) throw new Error('the holder could not renew its own lease')
				expect(renewed.fence).toBe(a.fence)
				expect((await log.activeTurn({ now: LATER }))?.state).toBe('running')
				const entry = await log.append(renewed, message(turnId, 'assistant', 'still running'))
				expect(entry.record.gen).toBe(a.fence)
			})
		})

		it('refuses a second turn while one is running', async () => {
			await withLog(async ({ log }) => {
				const lease = await opened(log)
				const first = generateTurnId()
				await log.beginTurn(lease, turnDraft(first))
				for (const abandonInterrupted of [false, true]) {
					const error = await rejection(() =>
						log.beginTurn(lease, turnDraft(generateTurnId()), { abandonInterrupted }),
					)
					expect(isTurnInProgressError(error)).toBe(true)
					expect((error as { state?: string }).state).toBe('running')
					expect((error as { activeTurnId?: string }).activeTurnId).toBe(first)
				}
				expect((await log.activeTurn({ now: NOW }))?.state).toBe('running')
			})
		})

		it('refuses a turn while one is paused, and never closes a paused turn implicitly', async () => {
			await withLog(async ({ log }) => {
				const lease = await opened(log)
				const first = generateTurnId()
				await log.beginTurn(lease, turnDraft(first))
				await log.append(lease, {
					type: 'turn_paused',
					turnId: first,
					reason: 'awaiting review',
					checkpointId: generateCheckpointId(),
				} as SessionRecordDraft)
				for (const abandonInterrupted of [false, true]) {
					const error = await rejection(() =>
						log.beginTurn(lease, turnDraft(generateTurnId()), { abandonInterrupted }),
					)
					expect(isTurnInProgressError(error)).toBe(true)
					expect((error as { state?: string }).state).toBe('paused')
				}
				expect((await log.activeTurn())?.state).toBe('paused')
				const closed = await log.abandonTurn(lease, first, 'operator abandoned it')
				expect(closed.record.type).toBe('turn_failed')
				expect((closed.record as { failure?: { code: string } }).failure?.code).toBe('abandoned')
				await log.beginTurn(lease, turnDraft(generateTurnId()))
			})
		})

		it('refuses a turn while one is interrupted, and abandonInterrupted closes only that turn', async () => {
			await withLog(async (handle) => {
				const a = await opened(handle.log)
				const first = generateTurnId()
				await handle.log.beginTurn(a, turnDraft(first))
				// Writer a's process is gone; its lease runs out and b takes over.
				const next = handle.reopen()
				const b = await claimed(next, 'writer-b', LATER)
				expect((await next.activeTurn({ now: LATER }))?.state).toBe('interrupted')
				const error = await rejection(() => next.beginTurn(b, turnDraft(generateTurnId())))
				expect(isTurnInProgressError(error)).toBe(true)
				expect((error as { state?: string }).state).toBe('interrupted')
				const refused = await rejection(() => next.append(b, message(first, 'user', 'more')))
				expect(nameOf(refused)).toBe('TurnRuleError')
				const second = generateTurnId()
				const begun = await next.beginTurn(b, turnDraft(second), { abandonInterrupted: true })
				expect(begun.record.turnId).toBe(second)
				const read = await next.readAll()
				const closing = read.entries.at(-2)?.record as {
					type: string
					turnId?: string
					failure?: { code: string }
				}
				expect(closing.type).toBe('turn_failed')
				expect(closing.turnId).toBe(first)
				expect(closing.failure?.code).toBe('interrupted')
				expect((await next.activeTurn({ now: LATER }))?.turnId).toBe(second)
			})
		})

		it('folds messages across compaction and replacement', async () => {
			await withLog(async ({ log }) => {
				const lease = await opened(log)
				const t1 = generateTurnId()
				await log.beginTurn(lease, turnDraft(t1))
				const promptId = generateMessageId()
				const prompt = await log.append(
					lease,
					message(t1, 'user', 'What is the password?', promptId),
				)
				const answerId = generateMessageId()
				await log.append(lease, message(t1, 'assistant', 'It is hunter2.', answerId))
				await log.append(lease, {
					type: 'message_replaced',
					turnId: t1,
					targetMessageId: answerId,
					content: { role: 'assistant', content: 'I cannot share credentials.' },
					reason: 'guardrail_rewritten',
				} as SessionRecordDraft)
				await log.append(lease, completed(t1, 'I cannot share credentials.', answerId))
				// Each message carries the id its own record was given — a
				// compaction summary member (below) never gets one, having no
				// record of its own.
				expect(await log.messages()).toEqual([
					{ role: 'user', content: 'What is the password?', id: promptId },
					{ role: 'assistant', content: 'I cannot share credentials.', id: answerId },
				])
				const head = await log.head()
				await log.append(lease, {
					type: 'compaction',
					compactionId: 'compaction-1',
					strategy: 'summarize',
					trigger: 'manual',
					replacesSeqRange: [prompt.record.seq, head?.pointer.seq ?? prompt.record.seq],
					summary: [{ role: 'system', content: 'Earlier: a refused credential request.' }],
					keptMessageIds: [answerId],
					tokensBefore: 100,
					tokensAfter: 20,
				} as SessionRecordDraft)
				const t2 = generateTurnId()
				await log.beginTurn(lease, turnDraft(t2))
				const thanksId = generateMessageId()
				await log.append(lease, message(t2, 'user', 'Thanks.', thanksId))
				expect(await log.messages()).toEqual([
					{ role: 'system', content: 'Earlier: a refused credential request.' },
					{ role: 'assistant', content: 'I cannot share credentials.', id: answerId },
					{ role: 'user', content: 'Thanks.', id: thanksId },
				])
				expect(await log.messages({ throughSeq: prompt.record.seq })).toEqual([
					{ role: 'user', content: 'What is the password?', id: promptId },
				])
			})
		})

		it('spills a body too large for one record and reads it back', async () => {
			await withLog(async ({ log }) => {
				const lease = await opened(log)
				const turnId = generateTurnId()
				await log.beginTurn(lease, turnDraft(turnId))
				const big = 'x'.repeat(5 * 1024 * 1024)
				const entry = await log.append(lease, message(turnId, 'user', big))
				const spill = (entry.record as { spill?: { bytes: number } }).spill
				expect(spill === undefined).toBe(false)
				expect(spill?.bytes ?? 0).toBeGreaterThan(big.length)
				const [folded] = await log.messages()
				expect((folded as { content: string }).content.length).toBe(big.length)
				expect((await log.readAll()).intact).toBe(true)
			})
		})

		it('repairs a torn tail on the record when the next writer takes the lease', async () => {
			await withLog(async (handle) => {
				if (handle.tamper === undefined) return
				const a = await opened(handle.log)
				const turnId = generateTurnId()
				await handle.log.beginTurn(a, turnDraft(turnId))
				const bytes = await handle.tamper.bytes()
				const fragment = new TextEncoder().encode('{"v":1,"type":"message","id":"cut-o')
				const torn = new Uint8Array(bytes.byteLength + fragment.byteLength)
				torn.set(bytes)
				torn.set(fragment, bytes.byteLength)
				await handle.tamper.overwrite(torn)
				const next = handle.reopen()
				const tolerant = await next.readAll({ mode: 'tolerant' })
				expect(tolerant.tornBytes).toBe(fragment.byteLength)
				await claimed(next, 'writer-b', LATER)
				const read = await next.readAll()
				expect(read.intact).toBe(true)
				expect(read.tornBytes).toBe(0)
				const repair = read.entries.at(-1)?.record as {
					type: string
					truncatedBytes?: number
					lastGoodSeq?: number
					turnId?: string
				}
				expect(repair.type).toBe('log_repaired')
				expect(repair.truncatedBytes).toBe(fragment.byteLength)
				expect(repair.lastGoodSeq).toBe(2)
				expect(repair.turnId).toBe(turnId)
			})
		})

		it('defers torn-tail repair on an admission claim until the first append', async () => {
			await withLog(async (handle) => {
				if (handle.tamper === undefined) return
				const first = await opened(handle.log)
				await handle.log.release(first)
				const bytes = await handle.tamper.bytes()
				const fragment = new TextEncoder().encode('{"partial":')
				const torn = new Uint8Array(bytes.byteLength + fragment.byteLength)
				torn.set(bytes)
				torn.set(fragment, bytes.byteLength)
				await handle.tamper.overwrite(torn)
				const next = handle.reopen()
				const lease = await next.claim({
					holder: 'writer-b',
					ttlMs: TTL,
					now: LATER,
					repairTornTail: false,
				})
				if (lease === null) throw new Error('the admission claim could not take the lease')
				expect(Array.from(await handle.tamper.bytes())).toEqual(Array.from(torn))
				expect((await next.readAll({ mode: 'tolerant' })).tornBytes).toBe(fragment.byteLength)
				await next.append(lease, {
					type: 'session_updated',
					title: 'authorized',
				} as SessionRecordDraft)
				const read = await next.readAll()
				expect(read.tornBytes).toBe(0)
				expect(read.entries.map((entry) => entry.record.type)).toEqual([
					'session_started',
					'log_repaired',
					'session_updated',
				])
			})
		})

		it('refuses a flipped byte on a strict read, and a tolerant read stops before it', async () => {
			await withLog(async (handle) => {
				if (handle.tamper === undefined) return
				const lease = await opened(handle.log)
				const turnId = generateTurnId()
				await handle.log.beginTurn(lease, turnDraft(turnId))
				await handle.log.append(lease, message(turnId, 'user', 'abcdefgh'))
				await handle.log.append(lease, message(turnId, 'assistant', 'ijklmnop'))
				const original = await handle.log.readAll()
				const bytes = await handle.tamper.bytes()
				const target = original.entries[2]?.pointer
				if (target === undefined) throw new Error('missing record')
				const text = new TextDecoder().decode(
					bytes.subarray(target.offset, target.offset + target.length),
				)
				const at = target.offset + Buffer.byteLength(text.slice(0, text.indexOf('abcdefgh')))
				const flipped = new Uint8Array(bytes)
				flipped[at] = 'A'.charCodeAt(0)
				await handle.tamper.overwrite(flipped)
				const reader = handle.reopen()
				const strict = await rejection(() => reader.readAll())
				expect(nameOf(strict)).toBe('SessionLogIntegrityError')
				const tolerant = await reader.readAll({ mode: 'tolerant' })
				expect(tolerant.intact).toBe(false)
				expect(tolerant.throughSeq).toBe(3)
				// The tail has no successor to vouch for it; an anchor does.
				const last = original.entries.at(-1)?.pointer
				if (last === undefined) throw new Error('missing record')
				const lastText = new TextDecoder().decode(
					bytes.subarray(last.offset, last.offset + last.length),
				)
				const tail = new Uint8Array(bytes)
				tail[last.offset + Buffer.byteLength(lastText.slice(0, lastText.indexOf('ijklmnop')))] =
					'Z'.charCodeAt(0)
				await handle.tamper.overwrite(tail)
				// Still a valid chain: nothing after the tail vouches for it.
				expect((await handle.reopen().readAll()).intact).toBe(true)
				const anchored = await rejection(() => handle.reopen().readAll({ expectHead: last }))
				expect(nameOf(anchored)).toBe('SessionLogIntegrityError')
			})
		})
	})
}
