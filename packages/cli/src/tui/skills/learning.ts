/**
 * Whether a finished turn is worth proposing as a skill.
 *
 * The interactive TUI's alone: `exec`, `drain`, ACP, a scheduled run and a
 * sub-agent never import this (a test says so). Nothing here saves anything
 * or costs a model call; it only decides whether one dim line is printed
 * under the reply. Saving is `/skills save`, which the operator types.
 *
 * Pure: it reads the turn's `AgentEvent`s and the facts the App passes in.
 * Persistence of the anti-nag counter lives in `suggestion-ledger.ts`.
 */

import { REVIEW_EXEMPT_WRITES, SKILL_TOOL_NAME } from '@namzu/sdk'

import { SAVE_SKILL_TOOL_NAME } from '../../skills/save.js'
import type { AgentEvent } from '../agent.js'

/** `skills.suggestMinToolCalls` when the config does not say. */
export const DEFAULT_SUGGEST_MIN_TOOL_CALLS = 6
/** Distinct tools a turn must have used. One tool run many times is a loop, not a procedure. */
export const SUGGEST_MIN_DISTINCT_TOOLS = 2
/** How many of the last tool results must have succeeded. */
export const SUGGEST_CLEAN_TAIL = 3

/**
 * What the kernel writes in place of a result for a call that never ran
 * (`deniedToolOutput`): a review the operator rejected, a gate rule, a mode
 * that refuses the tool.
 */
const DENIED_OUTPUT = /^Error: Tool "([^"]+)" was not executed\./

/** One turn, observed. Mutable so the App can feed it event by event. */
export interface TurnActivity {
	/** Successful tool results, bookkeeping writes left out. */
	steps: number
	readonly tools: Set<string>
	/** A successful call whose tool does not declare itself read-only for its input. */
	changedSomething: boolean
	/** Every result in order, true when it succeeded (bookkeeping included). */
	readonly results: boolean[]
	/** Tool names refused and not later run successfully. */
	readonly unresolvedDenials: Set<string>
	/** The turn loaded a skill with the skill tool. */
	skillUsed: boolean
	/** The turn called `save_skill`: it was already saving one. */
	savedSkill: boolean
	/** How the turn ended. `running` until a terminal event arrives. */
	ending: 'running' | 'answered' | 'stopped' | 'paused' | 'failed'
	readonly started: Map<string, { readonly toolName: string; readonly readOnly: boolean }>
}

export function createTurnActivity(): TurnActivity {
	return {
		steps: 0,
		tools: new Set(),
		changedSomething: false,
		results: [],
		unresolvedDenials: new Set(),
		skillUsed: false,
		savedSkill: false,
		ending: 'running',
		started: new Map(),
	}
}

/** Feed one event of the turn. Events of other kinds are ignored. */
export function observeTurnEvent(activity: TurnActivity, event: AgentEvent): void {
	switch (event.kind) {
		case 'tool-start': {
			activity.started.set(event.toolUseId, {
				toolName: event.toolName,
				readOnly: event.readOnly === true,
			})
			if (event.toolName === SKILL_TOOL_NAME) activity.skillUsed = true
			if (event.toolName === SAVE_SKILL_TOOL_NAME) activity.savedSkill = true
			return
		}
		case 'tool-end': {
			const start = activity.started.get(event.toolUseId)
			const toolName = start?.toolName ?? event.toolName
			if (toolName === SKILL_TOOL_NAME) activity.skillUsed = true
			if (toolName === SAVE_SKILL_TOOL_NAME) activity.savedSkill = true
			activity.results.push(!event.isError)
			if (event.isError) {
				const denied = DENIED_OUTPUT.exec(event.output ?? '')
				if (denied) activity.unresolvedDenials.add(denied[1] ?? toolName)
				return
			}
			activity.unresolvedDenials.delete(toolName)
			if (REVIEW_EXEMPT_WRITES.has(toolName.toLowerCase())) return
			activity.steps += 1
			activity.tools.add(toolName)
			// A call with no start (a provider-hosted search) only reads.
			if (start && !start.readOnly) activity.changedSomething = true
			return
		}
		case 'done':
			activity.ending =
				event.stopReason === undefined || event.stopReason === 'end_turn' ? 'answered' : 'stopped'
			return
		case 'paused':
			activity.ending = 'paused'
			return
		case 'error':
			activity.ending = 'failed'
			return
		default:
			return
	}
}

/** What the App knows that the events do not. */
export interface SuggestionContext {
	/** `skills.suggest`; only `false` turns proposals off. */
	readonly suggest?: boolean
	/** `skills.suggestMinToolCalls`. */
	readonly minToolCalls?: number
	/** The turn ran in `plan` mode, or the mode is `plan` now. */
	readonly planMode: boolean
	/** A skill was loaded earlier in this conversation (skill tool or `/skills <name>`). */
	readonly skillUsedInConversation: boolean
	/** This conversation already proposed one (or said proposals stopped). */
	readonly proposedInConversation: boolean
	/** The turn was sent by `/skills save` or `/skills new`. */
	readonly skillFlowTurn: boolean
}

export type SuggestionVerdict =
	| { readonly suggest: true; readonly steps: number; readonly tools: number }
	| { readonly suggest: false; readonly reason: SuggestionRefusal }

export type SuggestionRefusal =
	| 'turned-off'
	| 'not-answered'
	| 'plan-mode'
	| 'already-proposed'
	| 'skill-used'
	| 'skill-flow'
	| 'too-few-steps'
	| 'one-tool'
	| 'read-only'
	| 'failing-tail'
	| 'unresolved-denial'

/** Whether this turn earns the proposal. The order is cheapest reason first. */
export function judgeSkillSuggestion(
	activity: TurnActivity,
	context: SuggestionContext,
): SuggestionVerdict {
	const no = (reason: SuggestionRefusal): SuggestionVerdict => ({ suggest: false, reason })
	if (context.suggest === false) return no('turned-off')
	if (activity.ending !== 'answered') return no('not-answered')
	if (context.planMode) return no('plan-mode')
	if (context.proposedInConversation) return no('already-proposed')
	if (context.skillUsedInConversation || activity.skillUsed) return no('skill-used')
	if (context.skillFlowTurn || activity.savedSkill) return no('skill-flow')
	const min = normaliseMinToolCalls(context.minToolCalls)
	if (activity.steps < min) return no('too-few-steps')
	if (activity.tools.size < SUGGEST_MIN_DISTINCT_TOOLS) return no('one-tool')
	if (!activity.changedSomething) return no('read-only')
	const tail = activity.results.slice(-SUGGEST_CLEAN_TAIL)
	if (tail.some((ok) => !ok)) return no('failing-tail')
	if (activity.unresolvedDenials.size > 0) return no('unresolved-denial')
	return { suggest: true, steps: activity.steps, tools: activity.tools.size }
}

function normaliseMinToolCalls(value: number | undefined): number {
	return value !== undefined && Number.isInteger(value) && value >= 1
		? value
		: DEFAULT_SUGGEST_MIN_TOOL_CALLS
}

/** The dim row under the reply. */
export function skillSuggestionNotice(steps: number, tools: number): string {
	return `That took ${steps} steps across ${tools} tools. Save it as a reusable skill? /skills save [name] · /skills save off to stop suggesting`
}

/** Said once, in place of the proposal that would have followed three ignored ones. */
export const SUGGESTIONS_STOPPED_NOTICE =
	'Not suggesting skills any more: the last three suggestions went unused. /skills save on turns them back on.'
