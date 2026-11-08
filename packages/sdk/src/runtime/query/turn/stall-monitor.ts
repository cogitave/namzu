/**
 * Watches the steps of one turn for a run that keeps thinking without
 * changing anything, and the per-step reasoning cap that goes with it.
 *
 * Both judge what the turn did, not what the model says it will do. A step
 * changed something when it made a call that was not read-only and did not
 * fail, and the task list does not count: keeping a list is not progress on
 * the task.
 */

import type { ReasoningEffort } from '../../../types/provider/index.js'

/** What the model is told when a step spent its whole reasoning allowance before acting. */
export const REASONING_CAPPED_MESSAGE =
	'Your thinking for that step reached its limit before you acted, so it was cut short. Act now on what you already know: make the first change, or run the one command that tells you what you still need. Refine as you go; do not plan the whole task again.'

/** What the model is told when a reply held thinking but no answer and no action. */
export const REASONING_ONLY_MESSAGE =
	'Your last reply held thinking only: no answer and no action. Continue now: give your answer, or make the call that moves the task forward.'

/** What the model is told when several steps passed with nothing changed. */
export const STALL_NUDGE_MESSAGE =
	'Several steps have passed and nothing has changed yet. Begin changing things now: make the first edit you are sure of, or run the one check that settles what you are unsure of. Reading more or planning again will not move the task.'

/**
 * Said again, on one request only, when a step must act but the provider
 * refuses a forced tool choice: the instruction travels in words instead.
 */
export const FORCED_STEP_MESSAGE =
	'This reply must be a tool call, not more planning. Make the call that moves the task forward now.'

/** The default per-step reasoning allowance, in tokens. */
export const DEFAULT_MAX_REASONING_TOKENS = 24_000

/** Characters a token stands for when counting streamed reasoning. */
const CHARS_PER_TOKEN = 4

/** Efforts at which the per-step reasoning cap applies unless a host says otherwise. */
const CAPPED_EFFORTS: ReadonlySet<ReasoningEffort> = new Set(['medium', 'high', 'xhigh', 'max'])

/** How a turn bounds its reasoning. */
export interface ReasoningPaceConfig {
	/**
	 * The most reasoning one step may stream, in tokens. `0` removes the cap.
	 * When absent the cap is {@link DEFAULT_MAX_REASONING_TOKENS} at medium and
	 * higher effort and absent at lower effort or none.
	 */
	readonly maxTokens?: number
	/** Tunes the stall monitor, or `false` turns it off. */
	readonly stall?: false | StallConfig
}

/** The characters of reasoning a step may stream before it is cut, or `undefined` for no cap. */
export function reasoningCapChars(
	config: ReasoningPaceConfig | undefined,
	effort: ReasoningEffort | undefined,
): number | undefined {
	const configured = config?.maxTokens
	if (configured !== undefined) {
		return configured > 0 ? configured * CHARS_PER_TOKEN : undefined
	}
	if (effort === undefined || !CAPPED_EFFORTS.has(effort)) return undefined
	return DEFAULT_MAX_REASONING_TOKENS * CHARS_PER_TOKEN
}

/** Tools whose calls keep the task list; a turn that only does these has changed nothing. */
const TASK_LIST_TOOLS = new Set([
	'task_create',
	'task_update',
	'task_list',
	'task_get',
	'task_delete',
	'task_output',
	'task_stop',
])

/**
 * Whether a finished call changed something. A failed call changed nothing, a
 * task-list call is not progress, and a call the tool declares read-only only
 * looked. A tool that does not say is taken to have changed things.
 */
export function callChangedState(
	toolName: string,
	readOnly: boolean | undefined,
	isError: boolean | undefined,
): boolean {
	if (isError) return false
	if (TASK_LIST_TOOLS.has(toolName)) return false
	return readOnly !== true
}

/** When the monitor speaks. All counts are of consecutive steps that changed nothing. */
export interface StallConfig {
	/** Steps without a change after which the model is nudged. Default 12. */
	readonly nudgeAfterSteps?: number
	/** Reasoning characters streamed without a change after which the model is nudged. Default 80,000. */
	readonly nudgeAfterReasoningChars?: number
	/** Further steps without a change after the nudge that make the next step an action step. Default 5. */
	readonly forceAfterSteps?: number
}

/** What the monitor wants done after a step. */
export type StallDirective =
	| { readonly kind: 'none' }
	| { readonly kind: 'nudge'; readonly text: string }
	| { readonly kind: 'force' }

/** One finished step as the monitor sees it. */
export interface StallObservation {
	readonly reasoningChars: number
	readonly changedState: boolean
}

export class StallMonitor {
	private readonly nudgeAfterSteps: number
	private readonly nudgeAfterChars: number
	private readonly forceAfterSteps: number
	private idleSteps = 0
	private idleChars = 0
	private nudged = false
	private stepsSinceNudge = 0

	constructor(config?: StallConfig) {
		this.nudgeAfterSteps = config?.nudgeAfterSteps ?? 12
		this.nudgeAfterChars = config?.nudgeAfterReasoningChars ?? 80_000
		this.forceAfterSteps = config?.forceAfterSteps ?? 5
	}

	observe(step: StallObservation): StallDirective {
		if (step.changedState) {
			this.reset()
			return { kind: 'none' }
		}
		this.idleSteps += 1
		this.idleChars += step.reasoningChars
		if (!this.nudged) {
			if (this.idleSteps >= this.nudgeAfterSteps || this.idleChars >= this.nudgeAfterChars) {
				this.nudged = true
				this.stepsSinceNudge = 0
				return { kind: 'nudge', text: STALL_NUDGE_MESSAGE }
			}
			return { kind: 'none' }
		}
		this.stepsSinceNudge += 1
		if (this.stepsSinceNudge >= this.forceAfterSteps) {
			this.reset()
			return { kind: 'force' }
		}
		return { kind: 'none' }
	}

	private reset(): void {
		this.idleSteps = 0
		this.idleChars = 0
		this.nudged = false
		this.stepsSinceNudge = 0
	}
}
