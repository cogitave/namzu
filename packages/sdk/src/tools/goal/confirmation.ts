import type { SessionGoalStore } from '../../store/goal/index.js'
import { StaleGoalError } from '../../store/goal/index.js'
import type { GoalConfirmedBy, GoalRoundAuthority, SessionGoal } from '../../types/goal/index.js'
import type { HandBack } from '../../types/session/hand-back.js'
import type { TurnOutcome } from '../../types/session/outcome.js'
import { showCommand } from '../coordinator/outcome-record.js'
import { handBackKindSentence, handBackReason } from '../hand-back/index.js'

/**
 * Ending a goal by the record of the work.
 *
 * Today the model's own report ends a goal. With `confirmedBy: 'record'` the
 * kernel first reads the record it keeps of the work (`Turn.outcome`, built
 * from what the tool calls did and never from what the model says) and the
 * goal ends only as that record allows. There is no judge model and no model
 * call beyond the turns themselves: the decision is a pure function over what
 * the model reported, the record and the count of refusals so far.
 */

/**
 * Times the record may send a goal back to the model before the goal ends as
 * not confirmed. Three: a first refusal normally costs one fix and one rerun of
 * the check, a second covers a fix that did not hold, a third a check that
 * needed a second look; past that the model is looping, and every further
 * refusal costs a model call that has stopped moving the work. The limit is
 * per goal and a host can set its own.
 */
export const DEFAULT_GOAL_REFUSALS = 3

/** The `reasonCode` that makes a `complete` report say that no check exists to run. */
export const NO_CHECK_REASON_CODE = 'no-check-available'

/** How a goal ended once the record had been read. */
export type GoalEnding =
	/** A check passed and nothing changed after it. */
	| 'confirmed'
	/** The model said it was done; the record cannot confirm or contradict it. */
	| 'stated-not-checked'
	/** The record disagrees and the model could not or would not put it right. */
	| 'not-confirmed'

/** What the model reported. */
export type GoalStatement =
	/** The goal is met. */
	| 'met'
	/** The goal is met, and no check exists to run. */
	| 'no-check'
	/** The goal is not met: the model could not make the check pass. */
	| 'could-not'

export type GoalDecision =
	| { readonly kind: 'end'; readonly ending: GoalEnding; readonly sentence: string }
	| { readonly kind: 'refuse'; readonly sentence: string; readonly note: string }

export interface GoalDecisionInput {
	readonly statement: GoalStatement
	/** The record of the turn the report was made in; `undefined` when none was kept. */
	readonly record: TurnOutcome | undefined
	/** Refusals already given to this goal. */
	readonly refusals: number
	/** Most refusals this goal may be given. */
	readonly maxRefusals: number
	/**
	 * An earlier round of this same goal changed files. Never makes a goal
	 * confirmed; it only keeps a round that changed nothing and ran nothing from
	 * being read as proof that nothing needed checking.
	 */
	readonly earlierRoundsChanged?: boolean
}

/** The record in plain words, without a lead and without a final stop. */
export function recordSentence(record: TurnOutcome | undefined): string {
	if (record === undefined) return 'there is no record of this work'
	const named = (command: string | undefined): string =>
		command === undefined ? 'a check' : (showCommand(command) ?? 'a command')
	const passedCheck = [...record.checks].reverse().find((check) => check.result === 'passed')
	switch (record.verdict) {
		case 'checked':
			return `${named(passedCheck?.command)} passed and nothing changed after it`
		case 'unchanged':
			return passedCheck
				? `${named(passedCheck.command)} passed and nothing changed`
				: 'nothing changed and no check ran'
		case 'stale':
			return 'files changed after the last passing check'
		case 'failing': {
			const failed = record.checks.filter((check) => check.result === 'failed')
			const more = failed.length > 1 ? ` (and ${failed.length - 1} more)` : ''
			return `${named(failed[0]?.command)} failed${more}`
		}
		case 'unchecked':
			return 'files changed and no check ran'
		case 'inconclusive': {
			const masked = record.checks.find((check) => check.result === 'masked')
			if (masked) {
				const how = /(?<!\|)\|(?!\|)/.test(masked.command) ? 'the pipe' : 'the command line'
				return `${named(masked.command)} ran, but ${how} hides whether it passed`
			}
			const unsettled = record.checks.find((check) => check.result === 'unsettled')
			if (unsettled) return `${named(unsettled.command)} ran, but its result was not seen`
			return 'files changed and no check gave a result that could be read'
		}
		case 'unknown':
			return 'a command ran that may have changed files, and nothing could tell whether it did'
	}
}

const HOW_TO_SAY_SO =
	'To say so, call update_goal with status "blocked" and the reason if the check cannot be made to pass, or with status "complete", reasonCode "no-check-available" and the reason if no check exists here.'

function refusalNote(record: TurnOutcome | undefined, earlierChanged: boolean): string {
	switch (record?.verdict) {
		case 'failing':
			return `The record says ${recordSentence(record)}. Fix what it reports and run it again, or say plainly that you could not make it pass. ${HOW_TO_SAY_SO}`
		case 'stale':
			return `The record says ${recordSentence(record)}. Run the check again, or say plainly that you could not. ${HOW_TO_SAY_SO}`
		case 'unchecked':
			return `The record says ${recordSentence(record)}. Run the project's check on the files as they are now, or say plainly that no check can be run here. ${HOW_TO_SAY_SO}`
		case 'inconclusive':
			return `The record says ${recordSentence(record)}. Run the check again on its own so that its result can be read, or say plainly that you could not. ${HOW_TO_SAY_SO}`
		default:
			return earlierChanged
				? `The record of this round says ${recordSentence(record)}, and an earlier round of this goal changed files. Run the project's check on the files as they are now, or say plainly that you could not. ${HOW_TO_SAY_SO}`
				: `The record says ${recordSentence(record)}. Run the check, or say plainly that you could not. ${HOW_TO_SAY_SO}`
	}
}

/**
 * What to do with the model's report of a goal, given the record.
 *
 * - The model says it could not: the goal ends `not-confirmed`; it is never
 *   pushed again.
 * - The model says no check exists: `stated-not-checked`, unless the record
 *   holds a failing or stale check (`not-confirmed`) or a passing one
 *   (`confirmed`).
 * - The model says it is met: a passing check with nothing changed after it is
 *   `confirmed`; a failing check, files changed after the last pass, files
 *   changed and no check, or a check whose result could not be read are refused
 *   while refusals remain and `not-confirmed` once they do not; nothing
 *   changed, a command that may have changed files (`unknown`) or no record at
 *   all is `stated-not-checked`. `unknown` is not refused on purpose: the
 *   record keeps it for the whole turn, so no later check could clear it and a
 *   refusal would only cost calls until the bound.
 */
export function decideGoalConfirmation(input: GoalDecisionInput): GoalDecision {
	const { statement, record, refusals, maxRefusals } = input
	const sentence = recordSentence(record)
	if (statement === 'could-not') return { kind: 'end', ending: 'not-confirmed', sentence }

	const verdict = record?.verdict
	if (verdict === 'checked') return { kind: 'end', ending: 'confirmed', sentence }
	if (
		verdict === 'unchanged' &&
		record?.checks.some((check) => check.result === 'passed' && check.fresh !== false)
	) {
		return { kind: 'end', ending: 'confirmed', sentence }
	}

	const contradicted = verdict === 'failing' || verdict === 'stale'
	if (statement === 'no-check') {
		return contradicted
			? { kind: 'end', ending: 'not-confirmed', sentence }
			: { kind: 'end', ending: 'stated-not-checked', sentence }
	}

	const earlierChanged = input.earlierRoundsChanged === true
	const refusable =
		contradicted ||
		verdict === 'unchecked' ||
		verdict === 'inconclusive' ||
		(verdict === 'unchanged' && earlierChanged)
	if (!refusable) return { kind: 'end', ending: 'stated-not-checked', sentence }
	if (refusals >= Math.max(0, maxRefusals)) {
		return { kind: 'end', ending: 'not-confirmed', sentence }
	}
	return { kind: 'refuse', sentence, note: refusalNote(record, earlierChanged) }
}

/** How a goal ended, for the line a person reads and for a machine reading the result. */
export interface GoalEndingReport {
	readonly goalId: string
	readonly ending: GoalEnding
	/** The record in plain words, as {@link recordSentence} writes it. */
	readonly sentence: string
	/** How many times the record sent this goal back before it ended. */
	readonly refusals: number
	/**
	 * Set when the goal ended because the model handed the task back to a person
	 * (`hand_back_task`). The ending is `not-confirmed` and `sentence` is the
	 * kernel's sentence for the kind; the model's own words are in the hand-back.
	 */
	readonly handedBack?: HandBack
}

/** The closing line of a goal: which of the three endings it was and, always, what the record held. */
export function describeGoalEnding(
	report: Pick<GoalEndingReport, 'ending' | 'sentence' | 'handedBack'>,
): string {
	if (report.handedBack) {
		return `Goal not confirmed: the model handed the task back to a person (${report.sentence}).`
	}
	switch (report.ending) {
		case 'confirmed':
			return `Goal confirmed by the record: ${report.sentence}.`
		case 'stated-not-checked':
			return `Goal stated, not checked: the record cannot confirm it (${report.sentence}).`
		case 'not-confirmed':
			return `Goal not confirmed: the record says ${report.sentence}.`
	}
}

export interface GoalConfirmationOptions {
	readonly store: SessionGoalStore
	/** The same resolver the goal tools use: the authority of the turn, or none. */
	readonly resolveAuthority: (turnId: string) => GoalRoundAuthority | null | undefined
	/** What a goal that did not choose is confirmed by. Default `model`, the behaviour before this existed. */
	readonly defaultConfirmedBy?: GoalConfirmedBy
	/** Refusals a goal may be given. Default {@link DEFAULT_GOAL_REFUSALS}. */
	readonly maxRefusals?: number
}

interface Claim {
	readonly statement: GoalStatement
	readonly reason?: string
}

/**
 * Holds, for one session, what the model reported this turn, how many times a
 * goal was sent back, and whether an earlier round of it changed files. All of
 * it lives in memory: a restart begins the count again, which is the cautious
 * side of the bound only in that the model gets its refusals again.
 */
export class GoalConfirmation {
	private readonly claims = new Map<string, Claim>()
	private readonly refusals = new Map<string, number>()
	private readonly changed = new Set<string>()
	private readonly endings = new Map<string, GoalEndingReport>()

	constructor(private readonly options: GoalConfirmationOptions) {}

	/** What decides this goal: its own choice, else the host's setting, else the model. */
	confirmedByFor(goal: Pick<SessionGoal, 'confirmedBy'>): GoalConfirmedBy {
		return goal.confirmedBy ?? this.options.defaultConfirmedBy ?? 'model'
	}

	get maxRefusals(): number {
		return this.options.maxRefusals ?? DEFAULT_GOAL_REFUSALS
	}

	/** Refusals given to a goal so far. */
	refusalsFor(goalId: string): number {
		return this.refusals.get(goalId) ?? 0
	}

	/**
	 * The model reported on the goal in the round now running; the record is read
	 * when it finishes its answer. Held by goal, because only one round of a goal
	 * runs at a time and a round that ends without an answer leaves the goal
	 * active: the next report replaces this one.
	 */
	claim(goalId: string, statement: GoalStatement, reason?: string): void {
		this.claims.set(goalId, { statement, ...(reason !== undefined ? { reason } : {}) })
	}

	/** The ending the turn's goal came to, once; `undefined` when it did not end here. */
	takeEnding(turnId: string): GoalEndingReport | undefined {
		const ending = this.endings.get(turnId)
		this.endings.delete(turnId)
		return ending
	}

	/**
	 * The model handed this round's task back to a person: the goal, when this
	 * turn is a round of an active one, ends as not confirmed and is left blocked
	 * with the reason, whatever it was confirmed by. Nothing for any other turn.
	 */
	async handBack(turnId: string, handBack: HandBack): Promise<GoalEndingReport | undefined> {
		const authority = this.options.resolveAuthority(turnId)
		if (!authority) return undefined
		const goal = await this.options.store.getGoal(authority.sessionId, authority.tenantId)
		if (!goal || goal.id !== authority.id || goal.phase !== 'active') return undefined
		const ref = { id: authority.id, revision: authority.revision }
		try {
			await this.options.store.blockGoal(authority.sessionId, authority.tenantId, ref, {
				code: 'handed-back-to-a-person',
				message: handBackReason(handBack),
			})
		} catch (error) {
			if (error instanceof StaleGoalError) return undefined
			throw error
		}
		const report: GoalEndingReport = {
			goalId: goal.id,
			ending: 'not-confirmed',
			sentence: handBackKindSentence(handBack.kind),
			refusals: this.refusalsFor(goal.id),
			handedBack: handBack,
		}
		this.claims.delete(goal.id)
		this.refusals.delete(goal.id)
		this.changed.delete(goal.id)
		return report
	}

	/** Drop a report that was never answered for, when its round ends without the turn finishing an answer. */
	forget(goalId: string): void {
		this.claims.delete(goalId)
	}

	/**
	 * For `TurnConfig.outcome.beforeEnd`: the note that sends the model back to
	 * the work, or `undefined` when the turn may end. A turn that is not a round
	 * of a goal confirmed by the record is never touched.
	 */
	beforeEnd(
		turnId: string,
	): (read: () => Promise<TurnOutcome | undefined>) => Promise<string | undefined> {
		return async (read) => {
			const authority = this.options.resolveAuthority(turnId)
			if (!authority) return undefined
			const goal = await this.options.store.getGoal(authority.sessionId, authority.tenantId)
			if (!goal || goal.id !== authority.id || goal.phase !== 'active') return undefined
			if (this.confirmedByFor(goal) !== 'record') return undefined

			const record = await read()
			const claim = this.claims.get(goal.id)
			this.claims.delete(goal.id)
			const changedHere = (record?.changes.total ?? 0) > 0 || record?.changes.outsideKnownTools
			if (!claim) {
				if (changedHere) this.changed.add(goal.id)
				return undefined
			}

			const decision = decideGoalConfirmation({
				statement: claim.statement,
				record,
				refusals: this.refusalsFor(goal.id),
				maxRefusals: this.maxRefusals,
				earlierRoundsChanged: this.changed.has(goal.id),
			})
			if (changedHere) this.changed.add(goal.id)
			if (decision.kind === 'refuse') {
				this.refusals.set(goal.id, this.refusalsFor(goal.id) + 1)
				return decision.note
			}

			const ref = { id: authority.id, revision: authority.revision }
			try {
				if (decision.ending === 'not-confirmed') {
					const said = claim.reason ? ` The model said: ${claim.reason}` : ''
					await this.options.store.blockGoal(authority.sessionId, authority.tenantId, ref, {
						code: 'not-confirmed-by-record',
						message: `The record says ${decision.sentence}.${said}`,
					})
				} else {
					await this.options.store.completeGoal(authority.sessionId, authority.tenantId, ref)
				}
			} catch (error) {
				// The person changed the goal while the model was answering; what they
				// did stands, and nothing is said about an ending that did not happen.
				if (error instanceof StaleGoalError) return undefined
				throw error
			}
			this.endings.set(turnId, {
				goalId: goal.id,
				ending: decision.ending,
				sentence: decision.sentence,
				refusals: this.refusalsFor(goal.id),
			})
			this.refusals.delete(goal.id)
			this.changed.delete(goal.id)
			return undefined
		}
	}
}
