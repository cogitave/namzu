import type { RunId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { StepResult } from './step.js'

/**
 * What the loop knows before it calls the model again.
 *
 * `stopWhen` (shipped earlier) let a run DECIDE TO STOP based on what the
 * steps produced. This is the other half of the same idea: deciding how
 * the next step should be shaped. Without it, a run's tool surface, model
 * and sampling parameters are fixed at `query()` time, so a phased agent —
 * research with search tools, then write with file tools, then verify with
 * a cheaper model — had to be built as three separate runs, each losing
 * the prior one's context.
 */
export interface PrepareStepContext {
	readonly runId: RunId
	/** 1-based, matching the iteration number in events and traces. */
	readonly stepNumber: number
	/** Full history as it stands, so a decision can read what happened. */
	readonly messages: readonly Message[]
	/** Every completed step, in order. */
	readonly steps: readonly StepResult[]
}

/**
 * Overrides for the NEXT step. Every field is optional; an omitted field
 * keeps the run's configured value, and returning nothing at all is the
 * same as not supplying a `prepareStep`.
 */
export interface PrepareStepResult {
	/**
	 * Restrict which tools the model may call this step, by name. Names
	 * that are not registered are dropped with a warning rather than
	 * failing the run — a phase list that outlives a tool rename should
	 * narrow the surface, not kill the agent mid-run.
	 *
	 * **This costs a prompt-cache prefix.** Tools render at position 0, so
	 * changing the set between steps invalidates the cached prefix for that
	 * step. That is inherent to narrowing, not an implementation detail, so
	 * it is worth doing when a phase boundary genuinely changes what the
	 * agent should reach for — and not worth doing every step.
	 *
	 * Note it does NOT touch `tool_choice`. Not every provider has an `allowed_tools`
	 * parameter, and moving `tool_choice` invalidates cached MESSAGE blocks
	 * as well — a strictly worse trade for the same effect.
	 */
	readonly activeTools?: readonly string[]

	/** Use a different model for this step. */
	readonly model?: string

	/**
	 * Guidance for this step ONLY, appended as a system message that is not
	 * retained afterwards.
	 *
	 * Kept separate from the run's system prompt on purpose: the prompt is
	 * the cached prefix, and rewriting it per step would bust the cache on
	 * every iteration for what is usually one sentence of phase direction.
	 */
	readonly system?: string

	readonly temperature?: number
	readonly maxResponseTokens?: number
}

/**
 * Called before each model call, with everything the run has produced so
 * far.
 *
 * A throw fails OPEN — the step proceeds with the run's configured values.
 * Same reasoning as `stopWhen` and deliberately opposite to a guardrail: a
 * broken step-shaping hook should not kill an otherwise healthy run, and
 * unlike a safety check, nothing unsafe gets through when it is skipped.
 */
export type PrepareStep = (
	context: PrepareStepContext,
) => PrepareStepResult | undefined | Promise<PrepareStepResult | undefined>
