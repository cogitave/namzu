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
export const SESSION_SKILL = 'session-guidance'
export const SESSION_AGENT_KEY = 'sessions'
const SKILL = SESSION_SKILL
const AGENT_KEY = SESSION_AGENT_KEY
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
			/** `muted` marks advice (the read-first guard), not a fault. */
			readonly plainFailureTone?: 'muted'
			readonly declined?: unknown
			readonly cancelled?: boolean
	  }
	| {
			readonly kind: 'done'
			readonly turnId?: string
			readonly stopReason?: string
	  }
	| {
			readonly kind: 'paused'
			readonly turnId: string
			readonly reason: string
			readonly failure?: unknown
			readonly providerError?: unknown
	  }
	| {
			readonly kind: 'provider-wait'
			readonly turnId?: string
			readonly code: string
			readonly attempt: number
			readonly maxRetries: number
	  }
	| { readonly kind: 'provider-fallback' }
	| {
			readonly kind: 'history-repair'
			readonly duplicateResults: number
			readonly orphanedResults: number
			readonly interruptedCalls: number
			readonly rejectedImages?: number
	  }
	| { readonly kind: 'context'; readonly row?: string; readonly shed: boolean }
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

/**
 * A short masked excerpt of free text (used for tool names and codes, never
 * for a failure message, whose words cannot be masked reliably): home folders, absolute paths,
 * links, email addresses, `key=value` secrets, bearer credentials and long
 * token-like strings are replaced. Other words in the message are kept, so it
 * is an excerpt, not a guarantee that no sensitive word survives.
 */
export function redactSummary(text: string, home = homedir()): string {
	let value = Array.from(text)
		.map((c) => (/[\p{Cc}\p{Cf}]/u.test(c) ? ' ' : c))
		.join('')
	if (home.length > 1) value = value.split(home).join('~')
	value = value
		.replace(/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, '[email]')
		.replace(/https?:\/\/\S+/g, '[link]')
		.replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [redacted]')
		.replace(
			/\b([\w.-]*(?:pass(?:word|wd)?|secret|token|key|auth|credential)[\w.-]*)\s*[=:]\s*\S+/gi,
			'$1=[redacted]',
		)
		.replace(/(^|[\s("'=])\/(?:[\w.@~+-]+\/)+[\w.@~+-]*/g, '$1[path]')
		.replace(/(^|[\s("'=])(?:[A-Za-z]:|\\\\[\w.$-]+)[\\/][^\s"')]*/g, '$1[path]')
		.replace(/[A-Za-z0-9_\-+/=]{24,}/g, '[redacted]')
		.replace(/\s+/g, ' ')
		.trim()
	const chars = Array.from(value)
	return chars.length > 160 ? `${chars.slice(0, 160).join('')}…` : chars.join('')
}

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

/** When the record was written: its own stamp, else the session id's clock, else unknown. */
export function observedTime(record: { trace: string; sessionId: string }): number | null {
	const stamped = /^Recorded at (\S+?)\. /.exec(record.trace)
	if (stamped) {
		const at = Date.parse(stamped[1] as string)
		if (Number.isFinite(at)) return at
	}
	return uuidTime(record.sessionId)
}

interface Classified {
	readonly evaluator: string
	readonly outcome: LearningObservation['outcome']
	readonly taskKey: string
	readonly key: string
	readonly reason: string
	readonly turnId?: string
}

/**
 * Stop reasons that mean a turn failed without recovering. The person's own
 * cancel, a rejected plan, a stop the caller asked for and a plain pause are
 * choices, not failures, and are never recorded.
 */
const UNRECOVERED_STOPS = new Set([
	'timeout',
	'max_iterations',
	'token_budget',
	'cost_limit',
	'cost_unmeasurable',
	'error',
	'step_refused',
	'structured_output_failed',
	'output_limit',
	'answer_rejected',
	'input_guardrail',
	'output_guardrail',
])

function classify(event: FeedEvent): Classified | null {
	if (event.kind === 'tool-end') {
		const e = event as Extract<FeedEvent, { kind: 'tool-end' }>
		if (!e.isError || e.declined || e.cancelled) return null
		// The read-first guard is the tool working as designed, shown as advice
		// and not as a fault; only a failure drawn as one is a failure to learn from.
		if (e.plainFailureTone === 'muted') return null
		return {
			evaluator: 'tool-failure-v1',
			outcome: 'failed',
			taskKey: `tool:${e.toolName}`,
			key: `tool:${e.toolName}`,
			reason: `A ${redactSummary(e.toolName, '')} call failed. The message is not kept.`,
			...(e.turnId ? { turnId: e.turnId } : {}),
		}
	}
	if (event.kind === 'done') {
		const e = event as Extract<FeedEvent, { kind: 'done' }>
		if (!e.stopReason || !UNRECOVERED_STOPS.has(e.stopReason)) return null
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
		// A plain approval or hand-off pause is the conversation working as
		// designed; only a pause that carries a failure is one.
		if (e.failure === undefined && e.providerError === undefined) return null
		return {
			evaluator: 'turn-pause-v1',
			outcome: 'unresolved',
			taskKey: 'paused',
			key: 'paused',
			reason: 'The turn paused because of a failure. The message is not kept.',
			turnId: e.turnId,
		}
	}
	// Recoveries: the turn went on, but something had to be worked around. The
	// wording is fixed here; the event's own text is never copied.
	if (event.kind === 'provider-wait') {
		const e = event as Extract<FeedEvent, { kind: 'provider-wait' }>
		const code = redactSummary(e.code, '')
		return {
			evaluator: 'provider-retry-v1',
			outcome: 'unresolved',
			taskKey: `recovered:provider-retry:${code}`,
			key: `recovered:provider-retry:${code}`,
			reason: `The provider failed a request (${code}) and the turn asked again after a wait; attempt ${e.attempt} of ${e.maxRetries}.`,
			...(e.turnId ? { turnId: e.turnId } : {}),
		}
	}
	if (event.kind === 'provider-fallback') {
		return {
			evaluator: 'provider-fallback-v1',
			outcome: 'unresolved',
			taskKey: 'recovered:provider-fallback',
			key: 'recovered:provider-fallback',
			reason: 'A provider could not serve and the reply moved to the next one in the chain.',
		}
	}
	if (event.kind === 'history-repair') {
		const e = event as Extract<FeedEvent, { kind: 'history-repair' }>
		return {
			evaluator: 'history-repair-v1',
			outcome: 'unresolved',
			taskKey: 'recovered:history-repair',
			key: 'recovered:history-repair',
			reason: `The conversation history was repaired before a model call: ${e.duplicateResults} duplicate, ${e.orphanedResults} orphaned, ${e.interruptedCalls} interrupted, ${e.rejectedImages ?? 0} rejected image.`,
		}
	}
	if (event.kind === 'context') {
		const e = event as Extract<FeedEvent, { kind: 'context' }>
		if (e.row !== 'warning') return null
		return {
			evaluator: 'compaction-failure-v1',
			outcome: 'unresolved',
			taskKey: 'recovered:compaction-failure',
			key: 'recovered:compaction-failure',
			reason: 'A compaction pass failed and the history was left unchanged.',
		}
	}
	if (event.kind === 'error') {
		const e = event as Extract<FeedEvent, { kind: 'error' }>
		if (e.turnInProgress) return null
		const provider = e.providerError !== undefined
		const rawCode = (e.providerError as { code?: unknown } | undefined)?.code
		const code =
			(typeof rawCode === 'string' || typeof rawCode === 'number') &&
			/^[\w.-]{1,40}$/.test(String(rawCode))
				? String(rawCode)
				: ''
		return {
			evaluator: provider ? 'provider-error-v1' : 'turn-error-v1',
			outcome: 'execution-error',
			taskKey: provider ? 'provider-error' : 'turn-error',
			key: provider ? 'provider-error' : 'turn-error',
			reason: `${provider ? 'The provider failed' : 'The turn failed'}${code ? ` (${code})` : ''}. The message is not kept.`,
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
			trace: `Recorded at ${new Date(now()).toISOString()}. Conversation ${options.sessionId}, turn ${turnId}. ${found.reason}`,
		}
		await target.observe(observation)
		if (!pruned) {
			pruned = true
			const cutoff = now() - RETENTION_DAYS * DAY_MS
			await target.pruneObservations((record) => {
				const made = observedTime(record)
				// An age that cannot be shown is not kept: the promise is 30 days.
				return made === null || made < cutoff
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
