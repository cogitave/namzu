import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
	type LearningObservation,
	type ProjectId,
	type SessionPaths,
	SqliteLearningStore,
	type TenantId,
} from '@namzu/sdk'
import { ensurePrivateStateDirectory } from '../state/private-directory.js'

/**
 * Failures and recoveries an ordinary conversation already classifies, kept as
 * learning observations so a later `namzu learn` has something real to work
 * from. A conversation needs no resident for this.
 *
 * What is kept: a reference to the conversation and turn, the kind of failure,
 * and one short redacted sentence. Never the prompt, the model's answer or a
 * tool's output. It stays in the project's own state directory, is never
 * uploaded, and is dropped after {@link RETENTION_DAYS} days. The
 * `learningObservations` config key turns it off.
 */
export const RETENTION_DAYS = 30

/** One standing target: guidance for how conversations are run in this project. */
const SKILL = 'session-guidance'
const AGENT_KEY = 'sessions'
const DAY_MS = 86_400_000

/** The events this module reads; the conversation's own event stream satisfies it. */
export type FeedEvent =
	| {
			readonly kind: 'tool-end'
			readonly turnId?: string
			readonly toolName: string
			readonly isError: boolean
			readonly summary: string
			readonly plainFailure?: string
			readonly declined?: unknown
			readonly cancelled?: boolean
	  }
	| {
			readonly kind: 'done'
			readonly turnId?: string
			readonly stopReason?: string
	  }
	| { readonly kind: 'paused'; readonly turnId: string; readonly reason: string }
	| {
			readonly kind: 'error'
			readonly message: string
			readonly failure?: unknown
			readonly providerError?: unknown
			readonly turnInProgress?: unknown
	  }
	| { readonly kind: string }

export interface SessionLearningFeedOptions {
	readonly paths: SessionPaths
	readonly tenantId: TenantId
	readonly projectId: ProjectId
	readonly sessionId: string
	/** For retention only; defaults to the wall clock. */
	readonly now?: () => number
}

export interface SessionLearningFeed {
	/** Offer one event. Never throws and never waits for the disk. */
	observe(event: FeedEvent): void
	/** Resolves when every offered event has been written or dropped. */
	flush(): Promise<void>
}

/** Plain, short and free of paths and long secrets-looking tokens. */
export function redactSummary(text: string, home = homedir()): string {
	let value = Array.from(text)
		.map((c) => (/[\p{Cc}\p{Cf}]/u.test(c) ? ' ' : c))
		.join('')
	if (home.length > 1) value = value.split(home).join('~')
	value = value
		.replace(/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, '[email]')
		.replace(/https?:\/\/\S+/g, '[link]')
		.replace(/[A-Za-z0-9_\-+/=]{24,}/g, '[redacted]')
		.replace(/\s+/g, ' ')
		.trim()
	const chars = Array.from(value)
	return chars.length > 160 ? `${chars.slice(0, 160).join('')}…` : chars.join('')
}

const sentence = (text: string) => (text ? text : 'No further detail was recorded.')

/** A stable, valid UUID for an event that carries no turn id of its own. */
function derivedTurnId(sessionId: string, kind: string, ordinal: number): string {
	const hex = createHash('sha256').update(`${sessionId}\0${kind}\0${ordinal}`).digest('hex')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** The moment a version-7 UUID was minted, or null for any other id. */
export function uuidTime(id: string): number | null {
	const hex = id.replace(/-/g, '')
	if (hex.length !== 32 || hex[12] !== '7') return null
	const time = Number.parseInt(hex.slice(0, 12), 16)
	return Number.isFinite(time) ? time : null
}

interface Classified {
	readonly evaluator: string
	readonly outcome: LearningObservation['outcome']
	readonly taskKey: string
	readonly key: string
	readonly reason: string
	readonly turnId?: string
}

function classify(event: FeedEvent): Classified | null {
	if (event.kind === 'tool-end') {
		const e = event as Extract<FeedEvent, { kind: 'tool-end' }>
		if (!e.isError || e.declined || e.cancelled) return null
		return {
			evaluator: 'tool-failure-v1',
			outcome: 'failed',
			taskKey: `tool:${e.toolName}`,
			key: `tool:${e.toolName}`,
			reason: `A ${redactSummary(e.toolName, '')} call failed: ${sentence(redactSummary(e.plainFailure ?? e.summary.split('\n')[0] ?? ''))}`,
			...(e.turnId ? { turnId: e.turnId } : {}),
		}
	}
	if (event.kind === 'done') {
		const e = event as Extract<FeedEvent, { kind: 'done' }>
		if (!e.stopReason || e.stopReason === 'end_turn') return null
		return {
			evaluator: 'turn-stop-v1',
			outcome: 'unresolved',
			taskKey: `stop:${e.stopReason}`,
			key: `stop:${e.stopReason}`,
			reason: `The turn stopped before it finished: ${redactSummary(e.stopReason, '')}.`,
			...(e.turnId ? { turnId: e.turnId } : {}),
		}
	}
	if (event.kind === 'paused') {
		const e = event as Extract<FeedEvent, { kind: 'paused' }>
		return {
			evaluator: 'turn-pause-v1',
			outcome: 'unresolved',
			taskKey: 'paused',
			key: 'paused',
			reason: `The turn paused: ${sentence(redactSummary(e.reason))}`,
			turnId: e.turnId,
		}
	}
	if (event.kind === 'error') {
		const e = event as Extract<FeedEvent, { kind: 'error' }>
		if (e.turnInProgress) return null
		const provider = e.providerError !== undefined
		return {
			evaluator: provider ? 'provider-error-v1' : 'turn-error-v1',
			outcome: 'execution-error',
			taskKey: provider ? 'provider-error' : 'turn-error',
			key: provider ? 'provider-error' : 'turn-error',
			reason: `${provider ? 'The provider failed' : 'The turn failed'}: ${sentence(redactSummary(e.message))}`,
		}
	}
	return null
}

export function createSessionLearningFeed(
	options: SessionLearningFeedOptions,
): SessionLearningFeed {
	const now = options.now ?? Date.now
	let store: SqliteLearningStore | null | undefined
	let pruned = false
	let queue: Promise<void> = Promise.resolve()
	const seen = new Set<string>()
	let ordinal = 0

	const open = (): SqliteLearningStore | null => {
		if (store !== undefined) return store
		try {
			const root = ensurePrivateStateDirectory(options.paths.projectDir(), 'learning')
			ensurePrivateStateDirectory(root, 'artifacts')
			store = new SqliteLearningStore({
				databasePath: join(root, 'learning.sqlite'),
				artifactsPath: join(root, 'artifacts'),
				scope: {
					tenantId: options.tenantId,
					projectId: options.projectId,
					agentKey: AGENT_KEY,
				},
			})
		} catch {
			store = null
		}
		return store
	}

	const write = async (event: FeedEvent): Promise<void> => {
		const found = classify(event)
		if (!found) return
		const turnId = found.turnId ?? derivedTurnId(options.sessionId, found.evaluator, ordinal++)
		const identity = `${turnId}:${found.evaluator}`
		if (seen.has(identity)) return
		seen.add(identity)
		const target = open()
		if (!target) return
		const observation: LearningObservation = {
			skillName: SKILL,
			evaluatorRevision: found.evaluator,
			baselineRevision: 'none',
			sessionId: options.sessionId,
			turnId,
			taskKey: found.taskKey,
			outcome: found.outcome,
			// A conversation's spend is settled elsewhere; none of these may start an experiment alone.
			usageComplete: false,
			evidence: {
				key: found.key,
				source: `session:${options.sessionId}`,
				reason: found.reason,
			},
			trace: `Conversation ${options.sessionId}, turn ${turnId}. ${found.reason}`,
		}
		await target.observe(observation)
		if (!pruned) {
			pruned = true
			const cutoff = now() - RETENTION_DAYS * DAY_MS
			await target.pruneObservations((record) => {
				const made = uuidTime(record.sessionId)
				return made !== null && made < cutoff
			})
		}
	}

	return {
		observe(event) {
			queue = queue.then(() => write(event)).catch(() => {})
		},
		flush: () => queue,
	}
}

/** The streams a conversation hands out, passed through unchanged while the feed watches them. */
interface FeedableSession {
	send(...args: never[]): AsyncIterable<unknown>
	resumePaused(...args: never[]): AsyncIterable<unknown>
	close?(...args: never[]): unknown
}

/**
 * The same session with `send` and `resumePaused` watched by `feed`. Every
 * other member, and every event, is exactly what the session produced.
 */
export function withSessionLearningFeed<T extends FeedableSession>(
	session: T,
	feed: SessionLearningFeed,
): T {
	const watch =
		<A extends unknown[], E>(open: (...args: A) => AsyncIterable<E>) =>
		(...args: A): AsyncIterable<E> =>
			(async function* () {
				for await (const event of open(...args)) {
					feed.observe(event as FeedEvent)
					yield event
				}
			})()
	// A view over the session, not a copy: members that are getters stay live.
	return Object.create(session, {
		send: { value: watch(session.send.bind(session) as never), enumerable: true },
		resumePaused: {
			value: watch(session.resumePaused.bind(session) as never),
			enumerable: true,
		},
		// What was offered is on disk before the session lets go.
		...(session.close
			? {
					close: {
						value: async (...args: never[]) => {
							await feed.flush()
							return (session.close as (...a: never[]) => unknown)(...args)
						},
						enumerable: true,
					},
				}
			: {}),
	}) as T
}
