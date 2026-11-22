/**
 * What the application tells a goal about each automatic turn, and the limits
 * it gives a goal when it is set.
 *
 * A goal is stopped by what it does, not by a fixed count of turns: a turn that
 * changed nothing and checked nothing, the same failure again, a pause every so
 * many turns for a person to look, an optional budget of tokens. The count of
 * turns is only a backstop. The store keeps the counts; this reads a finished
 * turn's record into the one small shape the store takes, and says in plain
 * words why a goal stopped.
 */

import {
	DEFAULT_GOAL_CHECK_IN_ROUNDS,
	DEFAULT_GOAL_STALL_ROUNDS,
	type GoalGuards,
	type GoalRoundAuthority,
	type GoalRoundOutcome,
	type SessionGoal,
	type SessionGoalStore,
	type TenantId,
	type TurnOutcome,
	goalCostText,
	goalTokensText,
} from '@namzu/sdk'
import type { GoalCliConfig } from '../config/schema.js'

/** Backstop on the automatic turns of one goal, when `goal.maxRounds` says nothing. */
export const DEFAULT_CLI_GOAL_MAX_ROUNDS = 1000

export interface GoalDefaults {
	readonly maxGoalRounds: number
	readonly guards: GoalGuards
}

/** The cap and the stop rules a goal gets in this application, from the `goal` settings. */
export function goalDefaults(config: GoalCliConfig | undefined): GoalDefaults {
	return {
		maxGoalRounds: config?.maxRounds ?? DEFAULT_CLI_GOAL_MAX_ROUNDS,
		guards: {
			stallRounds: config?.stallRounds ?? DEFAULT_GOAL_STALL_ROUNDS,
			checkInEvery: config?.checkInEvery ?? DEFAULT_GOAL_CHECK_IN_ROUNDS,
			...(config?.tokenBudget !== undefined ? { tokenBudget: config.tokenBudget } : {}),
		},
	}
}

function clip(text: string, max = 80): string {
	const flat = text.replace(/\s+/gu, ' ').trim()
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Whether a turn moved the work, from the kernel's record of its calls: files
 * changed, a command that may have changed them, or a check that ran. No record
 * is not evidence either way.
 */
export function roundProgress(record: TurnOutcome | undefined): GoalRoundOutcome['progress'] {
	if (record === undefined) return 'unknown'
	if (
		record.changes.total > 0 ||
		record.changes.outsideKnownTools ||
		record.checks.length > 0 ||
		record.verdict === 'unknown'
	) {
		return 'progress'
	}
	return 'empty'
}

/** The failure a turn ended on: the checks whose latest run failed, or `undefined`. */
export function roundFailure(record: TurnOutcome | undefined): string | undefined {
	const failed = record?.checks.filter((check) => check.result === 'failed') ?? []
	if (failed.length === 0) return undefined
	return failed
		.map((check) =>
			clip(`${check.command}${check.exitCode !== undefined ? ` (exit ${check.exitCode})` : ''}`),
		)
		.sort()
		.join('; ')
}

/** What the turn did, in a few words, or `undefined` when it did nothing. */
export function roundAction(record: TurnOutcome | undefined): string | undefined {
	if (record === undefined) return undefined
	const check = record.checks[record.checks.length - 1]
	if (check) return `ran ${clip(check.command, 60)}`
	const path = record.changes.paths[0]
	if (path !== undefined) {
		const more = record.changes.total > 1 ? ` and ${record.changes.total - 1} more` : ''
		return `changed ${clip(path, 60)}${more}`
	}
	if (record.changes.outsideKnownTools || record.verdict === 'unknown') return 'ran a command'
	return undefined
}

export interface RoundSummaryInput {
	readonly record: TurnOutcome | undefined
	/** The goal after the turn: a completion claim shows as a finished goal or a list of what is missing. */
	readonly goal: SessionGoal | null
	readonly tokens: number | undefined
	readonly costUsd: number | undefined
}

/** One finished turn in the shape the goal store takes. */
export function summarizeRound(input: RoundSummaryInput): GoalRoundOutcome {
	const claimed =
		input.goal !== null &&
		(input.goal.phase === 'complete' || (input.goal.missing?.length ?? 0) > 0)
	const failure = roundFailure(input.record)
	const action = roundAction(input.record)
	return {
		progress: claimed ? 'unknown' : roundProgress(input.record),
		...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
		...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
		...(failure !== undefined ? { failureSignature: failure } : {}),
		...(action !== undefined ? { action } : {}),
	}
}

/** What a goal has used so far, as one sentence for the lines that stop or pause it. */
export function goalSpentSentence(goal: SessionGoal): string {
	const turns = goal.roundsAdmitted
	return `${turns} automatic turn${turns === 1 ? '' : 's'}, ${goalTokensText(goal)} tokens, ${goalCostText(goal)}`
}

/** The plain sentence for a goal that stopped or paused by a rule, with what to do next. */
export function goalStopSentence(goal: SessionGoal): string | undefined {
	if (goal.phase === 'paused' && goal.pauseReason?.code === 'check-in') {
		return `${goal.pauseReason.message} Run /goal resume to continue.`
	}
	if (goal.phase !== 'blocked' || goal.blockedReason === undefined) return undefined
	const reason = goal.blockedReason
	switch (reason.code) {
		case 'no-progress':
			return `Goal stopped: ${reason.message} ${goalSpentSentence(goal)} so far. Run /goal resume to try again.`
		case 'repeated-failure':
			return `Goal stopped: ${reason.message} ${goalSpentSentence(goal)} so far. Fix the cause, then run /goal resume.`
		case 'budget-limited':
			return `Goal stopped at its token budget: ${reason.message} Raise it with /goal resume after setting goal.tokenBudget higher.`
		case 'round-limit':
			return `Goal stopped: ${reason.message} ${goalSpentSentence(goal)} so far. Run /goal resume to go on (raise goal.maxRounds first for more).`
		default:
			return undefined
	}
}

export interface RecordGoalRoundDeps {
	readonly goals: Pick<SessionGoalStore, 'getGoal' | 'recordRound'> | undefined
	readonly tenantId: TenantId | undefined
	readonly round: Pick<GoalRoundAuthority, 'id' | 'sessionId'>
	readonly record: TurnOutcome | undefined
	readonly tokens: number | undefined
	readonly costUsd: number | undefined
}

/**
 * Writes a finished goal round down and says why the goal stopped, when this
 * round is what stopped it. A store that cannot record, or a failure to read or
 * write, is left alone: the turn's own ending is already shown.
 */
export async function recordGoalRound(deps: RecordGoalRoundDeps): Promise<string | undefined> {
	const { goals, tenantId } = deps
	if (goals?.recordRound === undefined || tenantId === undefined) return undefined
	try {
		const before = await goals.getGoal(deps.round.sessionId, tenantId)
		if (!before || before.id !== deps.round.id) return undefined
		const after = await goals.recordRound(
			deps.round.sessionId,
			tenantId,
			deps.round.id,
			summarizeRound({
				record: deps.record,
				goal: before,
				tokens: deps.tokens,
				costUsd: deps.costUsd,
			}),
		)
		if (after && before.phase === 'active' && after.phase === 'blocked') {
			return goalStopSentence(after)
		}
	} catch {
		// Bookkeeping must never fail the turn it describes.
	}
	return undefined
}
