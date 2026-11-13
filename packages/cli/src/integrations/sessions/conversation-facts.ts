import {
	type DiskSessionLog,
	type SessionId,
	type SessionRecord,
	type SessionStartedRecord,
	foldSessionLog,
	streamSessionLog,
} from '@namzu/sdk'
import {
	PULL_REQUEST_PROTOCOL,
	type PullRequestLink,
	parsePullRequestLink,
} from '../github/pull-request.js'

/**
 * What one conversation's log says about it outside its messages, reduced in
 * one pass that keeps only the answers.
 *
 * Callers used to be handed every record of the log (118 to 150 MB live at
 * turn 200 of a long session, 0.5 GB allocated per read) to find a first
 * record, a title, a flag, an open turn, a timestamp and a few records. This
 * keeps those, and the handful of records the desktop host searches for as
 * typed queries on the result. Nothing else of the log is kept.
 */

type PausedRecord = Extract<SessionRecord, { type: 'turn_paused' }>

/** A skill whose hooks the conversation attached, as its latest `skill_hooks_attached` record keeps it. */
export interface SkillHooksFact {
	readonly skill: string
	readonly directory: string
	readonly grantsWithheld: boolean
	/** The `skill` call that loaded it, when the record names one. */
	readonly toolCallId?: string
	/** Every `skill` call that loaded it, oldest first (a skill used twice has two). */
	readonly toolCallIds?: readonly string[]
}

/** What the log says about one conversation, and typed queries over the few records callers search for. */
export interface ConversationFacts {
	readonly sessionId: SessionId
	readonly started: SessionStartedRecord
	/** The latest `session_updated.title`; empty or absent means derived. */
	readonly title?: string
	readonly named: boolean
	readonly archived: boolean
	readonly createdAt: string
	readonly updatedAt: string
	/** The session's open turn, if any, and whether it is parked. */
	readonly activeTurn?: { readonly turnId: string; readonly paused: boolean }
	/** The model of the latest `session_updated` that prepared a dispatch, if any named one. */
	readonly latestDispatchModel?: string
	/** The pull request the log last linked, or `undefined`. */
	readonly pullRequest?: PullRequestLink
	/** The model a turn was started with; `undefined` when no such turn started, `{}` when it named none. */
	startedTurn(turnId: string): { readonly model?: string } | undefined
	/** The latest `turn_paused` record of a turn. */
	latestPause(turnId: string): PausedRecord | undefined
	/** Whether the turn was ever resumed (`turn_resuming`). */
	wasResumed(turnId: string): boolean
	/** Whether any pause of a turn was a tool handoff. */
	pausedForHandoff(turnId: string): boolean
	/** The decisions a turn asked and nobody has answered or expired, as id to request type. */
	pendingDecisions(turnId: string): ReadonlyMap<string, string>
	/** The account the latest `account_bound` record of a provider named. */
	accountBinding(provider: string): string | undefined
	/** The skills whose hooks the conversation attached, oldest first, each by its latest record. */
	readonly skillHooks: readonly SkillHooksFact[]
}

/** A conversation read whole: the facts and every record, for callers that fold messages from them. */
export interface ConversationRecords extends ConversationFacts {
	readonly records: readonly SessionRecord[]
}

interface TurnFacts {
	model?: string
}

/** The running reduction. Applied record by record; `facts` answers without handing out its own state. */
export class ConversationFactsFold {
	#first: SessionRecord | undefined
	#lastTs: string | undefined
	#title: string | undefined
	#named = false
	#archived = false
	#active: { turnId: string; paused: boolean } | undefined
	#dispatchModel: string | undefined
	#pullRequest: PullRequestLink | undefined
	readonly #turns = new Map<string, TurnFacts>()
	readonly #pauses = new Map<string, PausedRecord>()
	readonly #handoffs = new Set<string>()
	readonly #resumed = new Set<string>()
	readonly #decisions = new Map<string, { turnId: string; type: string }>()
	readonly #accounts = new Map<string, string>()
	readonly #skillHooks = new Map<string, SkillHooksFact>()

	apply(record: SessionRecord): void {
		this.#first ??= record
		this.#lastTs = record.ts
		switch (record.type) {
			case 'session_updated':
				if (record.title !== undefined) {
					this.#title = record.title
					this.#named = record.titleSource === 'named' && record.title.length > 0
				}
				if (record.archived !== undefined) this.#archived = record.archived
				if (record.harness?.kind === 'dispatch-prepared' && record.harness.model) {
					this.#dispatchModel = record.harness.model
				}
				for (const ref of record.externalRefs?.add ?? []) {
					if (ref.protocol !== PULL_REQUEST_PROTOCOL) continue
					const link = parsePullRequestLink(ref.externalId)
					if (link) this.#pullRequest = link
				}
				break
			case 'turn_started':
				this.#active = { turnId: record.turnId, paused: false }
				if (!this.#turns.has(record.turnId)) {
					const model = record.config.model
					this.#turns.set(record.turnId, model ? { model } : {})
				}
				break
			case 'turn_paused':
				if (this.#active?.turnId === record.turnId) this.#active = { ...this.#active, paused: true }
				this.#pauses.set(record.turnId, record)
				if (record.handoff) this.#handoffs.add(record.turnId)
				break
			case 'turn_resuming':
				this.#resumed.add(record.turnId)
				if (this.#active?.turnId === record.turnId)
					this.#active = { ...this.#active, paused: false }
				break
			case 'turn_completed':
			case 'turn_failed':
				if (this.#active?.turnId === record.turnId) this.#active = undefined
				break
			case 'decision_requested':
				this.#decisions.set(record.decisionId, {
					turnId: record.turnId,
					type: record.request.type,
				})
				break
			case 'decision_resolved':
			case 'decision_expired':
				this.#decisions.delete(record.decisionId)
				break
			case 'account_bound':
				this.#accounts.set(record.provider, record.accountId)
				break
			case 'skill_hooks_attached': {
				// Latest use of a skill wins, and goes last.
				const earlier = this.#skillHooks.get(record.skill)?.toolCallIds ?? []
				const ids = record.toolCallId !== undefined ? [...earlier, record.toolCallId] : earlier
				this.#skillHooks.delete(record.skill)
				this.#skillHooks.set(record.skill, {
					skill: record.skill,
					directory: record.directory,
					grantsWithheld: record.grantsWithheld,
					...(record.toolCallId !== undefined ? { toolCallId: record.toolCallId } : {}),
					...(ids.length > 0 ? { toolCallIds: ids } : {}),
				})
				break
			}
		}
	}

	/** The facts so far, or `null` when the log does not open with `session_started`. */
	facts(sessionId: SessionId): ConversationFacts | null {
		const first = this.#first
		if (first === undefined || first.type !== 'session_started') return null
		// Copies: the reduction goes on being advanced while a caller holds these.
		const turns = new Map(this.#turns)
		const pauses = new Map(this.#pauses)
		const handoffs = new Set(this.#handoffs)
		const resumed = new Set(this.#resumed)
		const decisions = new Map(this.#decisions)
		const accounts = new Map(this.#accounts)
		const skillHooks = [...this.#skillHooks.values()]
		const active = this.#active ? { ...this.#active } : undefined
		return {
			sessionId,
			started: first,
			...(this.#title !== undefined ? { title: this.#title } : {}),
			named: this.#named,
			archived: this.#archived,
			createdAt: first.ts,
			updatedAt: this.#lastTs ?? first.ts,
			...(active ? { activeTurn: active } : {}),
			...(this.#dispatchModel !== undefined ? { latestDispatchModel: this.#dispatchModel } : {}),
			...(this.#pullRequest !== undefined ? { pullRequest: this.#pullRequest } : {}),
			startedTurn: (turnId) => turns.get(turnId),
			latestPause: (turnId) => pauses.get(turnId),
			wasResumed: (turnId) => resumed.has(turnId),
			pausedForHandoff: (turnId) => handoffs.has(turnId),
			pendingDecisions: (turnId) => {
				const pending = new Map<string, string>()
				for (const [id, decision] of decisions) {
					if (decision.turnId === turnId) pending.set(id, decision.type)
				}
				return pending
			},
			accountBinding: (provider) => accounts.get(provider),
			skillHooks,
		}
	}
}

/**
 * One conversation's facts, or `null` when its log is absent or does not open
 * with `session_started`.
 *
 * Strict: the first read of a process walks the whole log and refuses a broken
 * chain. Later reads resume after the last record folded and, before they do,
 * hash every byte before it against what this process verified, so a log
 * altered anywhere is refused here as it is by a read from byte 0, and only the
 * records appended since are parsed. Tolerant: one pass, reading what precedes
 * a break, nothing remembered.
 */
export async function foldConversationFacts(
	log: DiskSessionLog,
	file: string,
	sessionId: SessionId,
	mode: 'strict' | 'tolerant',
): Promise<ConversationFacts | null> {
	if (mode === 'strict') {
		return await foldSessionLog(log, {
			name: 'conversation-facts',
			mode: 'strict',
			reverify: true,
			create: () => new ConversationFactsFold(),
			apply: (state, entry) => state.apply(entry.record),
			result: (state) => state.facts(sessionId),
		})
	}
	const fold = new ConversationFactsFold()
	const walk = streamSessionLog(file, { mode: 'tolerant', sessionId })
	for (;;) {
		const step = await walk.next()
		if (step.done) break
		fold.apply(step.value.record)
	}
	return fold.facts(sessionId)
}

/** Facts over records already in hand. */
export function conversationFactsOf(
	sessionId: SessionId,
	records: readonly SessionRecord[],
): ConversationFacts | null {
	const fold = new ConversationFactsFold()
	for (const record of records) fold.apply(record)
	return fold.facts(sessionId)
}
