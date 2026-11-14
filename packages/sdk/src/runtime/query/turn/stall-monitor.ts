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
	'Your thinking for that step reached its limit before you acted, so it was cut short. Act now on what you already know: make the first change, or, if you were asked a question, answer with what you have and say what is missing. Refine as you go; do not plan the whole task again.'

/** What the model is told when a reply held thinking but no answer and no action. */
export const REASONING_ONLY_MESSAGE =
	'Your last reply held thinking only: no answer and no action. Continue now: give your answer, or make the call that moves the task forward.'

/** What the model is told when several steps passed with nothing changed. */
export const STALL_NUDGE_MESSAGE =
	'Several steps have passed and nothing has changed yet. Begin changing things now: make the first edit you are sure of. If you were asked a question, answer it now with what you have and say what is missing. Reading more or planning again will not move the task.'

/**
 * What the model is told when it was asked a question and several steps have
 * only looked. It names the way out as the answer, never as another command.
 */
export const ANSWER_NOW_MESSAGE =
	'You were asked a question and the last steps only looked around. Answer it now, in the language the person used and within what they asked for, using what you have already seen. If something is still missing, say what it is instead of running another command. Do not open with an apology.'

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
	/**
	 * Steps that only looked, in a turn the person opened with a question,
	 * after which the model is told to answer. Default 6: half of the general
	 * threshold, because a question is usually settled by two or three looks,
	 * and six looks that settled nothing are a model circling rather than
	 * gathering. It is a nudge only; a question never forces a tool call.
	 */
	readonly answerAfterSteps?: number
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
	/** The person's latest message asked a question, so the way out of a stall is an answer. */
	readonly question?: boolean
}

/** The longest message still read as a question; a longer one is a brief. */
const QUESTION_MAX_CHARS = 400

/**
 * Whether a person's message is mainly a question: short, and holding a
 * question mark that ends a sentence. A mark inside a web address or a
 * query string does not end one, and a long message is a task description
 * that happens to ask something. A question without a mark is held to the
 * general threshold.
 */
export function asksQuestion(text: string | undefined): boolean {
	if (text === undefined) return false
	const trimmed = text.trim()
	if (trimmed.length === 0 || trimmed.length > QUESTION_MAX_CHARS) return false
	return /[?\uFF1F\u061F](?=$|[\s"'\u201D\u2019)\]])/.test(trimmed)
}

export class StallMonitor {
	private readonly nudgeAfterSteps: number
	private readonly nudgeAfterChars: number
	private readonly forceAfterSteps: number
	private readonly answerAfterSteps: number
	private idleSteps = 0
	private idleChars = 0
	private nudged = false
	private stepsSinceNudge = 0

	constructor(config?: StallConfig) {
		this.nudgeAfterSteps = config?.nudgeAfterSteps ?? 12
		this.nudgeAfterChars = config?.nudgeAfterReasoningChars ?? 80_000
		this.forceAfterSteps = config?.forceAfterSteps ?? 5
		this.answerAfterSteps = config?.answerAfterSteps ?? 6
	}

	observe(step: StallObservation): StallDirective {
		if (step.changedState) {
			this.reset()
			return { kind: 'none' }
		}
		this.idleSteps += 1
		this.idleChars += step.reasoningChars
		const question = step.question === true
		if (!this.nudged) {
			if (question && this.idleSteps >= this.answerAfterSteps) {
				this.nudged = true
				this.stepsSinceNudge = 0
				return { kind: 'nudge', text: ANSWER_NOW_MESSAGE }
			}
			if (this.idleSteps >= this.nudgeAfterSteps || this.idleChars >= this.nudgeAfterChars) {
				this.nudged = true
				this.stepsSinceNudge = 0
				return { kind: 'nudge', text: question ? ANSWER_NOW_MESSAGE : STALL_NUDGE_MESSAGE }
			}
			return { kind: 'none' }
		}
		this.stepsSinceNudge += 1
		if (this.stepsSinceNudge >= this.forceAfterSteps) {
			this.reset()
			// A question is answered, not acted on: say it again instead of
			// forcing a tool call, which would only buy another command.
			return question ? { kind: 'nudge', text: ANSWER_NOW_MESSAGE } : { kind: 'force' }
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
