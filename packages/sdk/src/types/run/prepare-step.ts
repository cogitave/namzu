import type { RunId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { ToolChoice } from '../provider/chat.js'
import type { Skill } from '../skills/index.js'
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

	/**
	 * What the stages before this one decided, when several were supplied.
	 *
	 * Empty for the first stage, and empty for a single `prepareStep`.
	 * Reading it is how a later stage refines an earlier one — narrowing a
	 * tool set that has already been narrowed, or leaving a model alone
	 * because something upstream had a reason to change it.
	 */
	readonly prepared: Readonly<PrepareStepResult>
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
	 * Note it does NOT imply a `tool_choice`. Not every provider has an
	 * `allowed_tools` parameter, and moving `tool_choice` invalidates cached
	 * MESSAGE blocks as well — a strictly worse trade for the same effect.
	 * When a step genuinely needs the model FORCED rather than narrowed, ask
	 * for it explicitly through {@link PrepareStepResult.toolChoice} and pay
	 * that cost knowingly.
	 */
	readonly activeTools?: readonly string[]

	/**
	 * Force this step's tool use: `'required'` to make the model call
	 * something, `'none'` to forbid it, or a named function to demand that
	 * one. Absent leaves the provider's default.
	 *
	 * **It applies to this step only, by construction.** That is the whole
	 * reason it lives here rather than on the run config. A forced choice
	 * that persists makes the model call a tool, see the result, and be
	 * forced again — an agent that cannot stop. The one peer SDK that puts
	 * `tool_choice` on persistent model settings has to undo it with a
	 * tool-use tracker, an opt-out flag and a reset applied at two call
	 * sites; the flag defaults to on precisely because turning it off hangs
	 * the agent. Here there is nothing to reset and no flag to get wrong:
	 * the next step is prepared fresh, so the force cannot outlive the step
	 * that asked for it.
	 *
	 * **It costs more cache than `activeTools`.** Narrowing tools
	 * invalidates the tool prefix; moving `tool_choice` invalidates cached
	 * message blocks too. Worth it at a real phase boundary — "this step
	 * must produce the structured answer" — and not worth it as a habit.
	 */
	readonly toolChoice?: ToolChoice

	/**
	 * Put these skills in front of the model for this step only.
	 *
	 * A run's skills are fixed at `query()` time and rendered into the cached
	 * system prefix, so every skill a run might ever need is paid for on
	 * every single turn. A phased agent rarely needs them all at once —
	 * research wants the search skill, writing wants the style guide, and
	 * neither benefits from carrying the other.
	 *
	 * Rendered into the same ephemeral trailing system message `system`
	 * uses, and for the same reason: appending leaves the cached prefix
	 * intact, where rewriting the run's prompt would invalidate it every
	 * iteration for what is usually one phase's worth of guidance.
	 *
	 * ADDITIVE to the run's skills, not a replacement. A skill the run
	 * always carries is not something a step should be able to take away by
	 * naming a different one — that would make every step's list a complete
	 * restatement, and a phase that forgot one would silently lose it.
	 *
	 * Sub-agents are deliberately NOT per-step. Which agents `create_task`
	 * can reach is baked into that tool's input schema, so varying it would
	 * rebuild the tool catalogue every step — a worse prompt-cache trade
	 * than moving tools, for a narrowing a step can already express by
	 * withholding `create_task` through {@link PrepareStepResult.activeTools}.
	 */
	readonly skills?: readonly Skill[]

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

/**
 * One shaping stage, or several applied in order.
 *
 * A single slot is enough for one concern and no help with two. A host
 * with a per-tenant system prefix AND a cost-based model downgrade had to
 * hand-compose them into one callback, which puts the ordering in the
 * host's code where nothing can see it and makes each concern's failure
 * the other's problem.
 *
 * An ARRAY is ordered by declaration, not by registration. That
 * distinction is the whole reason this is safe where a plugin-style
 * fan-out would not be: the author writes the order down, so "who wins"
 * is a line of their code rather than an accident of install history.
 * Each stage sees what the ones before it decided, and a later stage
 * overrides a field an earlier one set — last writer wins, visibly.
 *
 * A stage that throws is skipped and the rest still run, so one broken
 * concern cannot silently disable the others.
 */
export type PrepareStepChain = PrepareStep | readonly PrepareStep[]
