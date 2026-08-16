import { renderSkillsSection } from '../persona/assembler.js'
import type { AgentRuntimeContext } from '../types/agent/base.js'
import type { Skill } from '../types/skills/index.js'

/**
 * A seam for putting something in the system prompt.
 *
 * The prompt was closed. `PromptBuilder` assembled a fixed list — base
 * prompt, persona or system prompt, skills, tool section, tier guidance,
 * environment — and every one of those was a branch written into the
 * builder. A capability that needed the model to know something (web tools
 * and their citation rules, a plugin's conventions, a host's house style)
 * had exactly two options: convince somebody to add a branch, or splice it
 * into `systemPrompt` and lose whatever was there.
 *
 * Skills is the first contributor through this seam, and deliberately so:
 * it was already a special case in four places in the builder, so making it
 * one is the smallest change that proves the seam carries a real one rather
 * than a shape invented to fit.
 */

export interface PromptContributionContext {
	readonly workingDirectory?: string
	readonly runtimeContext?: AgentRuntimeContext
	readonly skills?: readonly Skill[]
	/** The tools this turn may call, if the turn was narrowed. */
	readonly allowedTools?: readonly string[]
	/**
	 * Which iteration this is, 1-based — present only for `turn`.
	 *
	 * Absent for `static` and `dynamic`, and that absence is the type
	 * saying what the placement means: a contribution that needs to know
	 * which turn it is cannot be part of a prompt assembled once and
	 * cached.
	 */
	readonly iteration?: number
}

/**
 * Which half of the prompt this lands in.
 *
 * Not cosmetic, and the wrong answer is expensive in a way nothing reports.
 * `static` is the segment the prompt cache keeps and a provider caches
 * across turns; `dynamic` is re-sent every iteration. A contributor whose
 * text varies per turn but declares `static` either invalidates the cached
 * prefix on every iteration — paying full price for a cache that never
 * hits — or, worse, gets served the first turn's text forever.
 *
 * The rule: `static` iff the output depends only on things that cannot
 * change inside one run.
 */
export type PromptPlacement = 'static' | 'dynamic' | 'turn'

/**
 * `turn` is a third thing, not a looser `dynamic`.
 *
 * `static` and `dynamic` are both parts of the SYSTEM PROMPT: assembled
 * once per request, sent as system messages, and — for `static` — cached by
 * the provider across turns. `turn` is not in the system prompt at all. It
 * rides the ephemeral trailing message that a step's guidance, its skills
 * and the approval-policy notice already use: appended to the request,
 * never pushed onto the run's history, and gone the moment the request is
 * sent.
 *
 * That is the placement for state that changes DURING a run — a budget
 * running down, a queue draining, a policy that just moved. Putting such a
 * thing in `static` serves the first iteration's value forever; putting it
 * in `dynamic` re-sends it in a position the model reads as part of its
 * standing instructions rather than as a status.
 *
 * The cost of `turn` is real and worth stating: every iteration pays for it
 * in tokens, and it lands after the cached prefix so it cannot be cached.
 * The approval-policy notice is the shape to copy — it returns text only
 * when something actually changed, and `null` on every other turn.
 */

export interface PromptContribution {
	/**
	 * Stable and unique. Registration refuses a duplicate rather than
	 * letting the second silently win, because "my guidance stopped
	 * appearing" is the least debuggable failure this registry could have.
	 */
	readonly id: string
	readonly placement: PromptPlacement
	/** `null` for "nothing to say this time", which is not an error. */
	render(context: PromptContributionContext): string | null
}

/** Two contributions claiming one id. */
export class PromptContributionCollisionError extends Error {
	readonly details: { id: string }

	constructor(details: { id: string }) {
		super(`A prompt contribution with id "${details.id}" is already registered.`)
		this.name = 'PromptContributionCollisionError'
		this.details = details
	}
}

/**
 * What goes in the prompt beyond what the builder knows about.
 *
 * Registration order is the rendering order, and that is the contract: an
 * ordering derived from something else — priority numbers, id sort — would
 * have every contributor arguing about a number, and the prompt is read
 * top to bottom by a model that weights early text more.
 */
export class PromptContributionRegistry {
	private readonly byId = new Map<string, PromptContribution>()

	register(contribution: PromptContribution): void {
		if (this.byId.has(contribution.id)) {
			throw new PromptContributionCollisionError({ id: contribution.id })
		}
		this.byId.set(contribution.id, contribution)
	}

	/** Replace one already registered, for a host that owns both. */
	replace(contribution: PromptContribution): void {
		this.byId.set(contribution.id, contribution)
	}

	has(id: string): boolean {
		return this.byId.has(id)
	}

	/** In registration order. */
	list(): readonly PromptContribution[] {
		return [...this.byId.values()]
	}

	/**
	 * Every contribution for one placement, rendered, with the empty ones
	 * dropped.
	 *
	 * Dropping `null` here rather than at each call site is the point: a
	 * contributor that has nothing to say this turn must not leave a blank
	 * section behind, and four separate `if (x) parts.push(x)` sites is four
	 * chances for one of them to forget.
	 */
	render(placement: PromptPlacement, context: PromptContributionContext): readonly string[] {
		return this.list()
			.filter((contribution) => contribution.placement === placement)
			.map((contribution) => contribution.render(context))
			.filter((text): text is string => typeof text === 'string' && text.trim().length > 0)
	}
}

/** The id the built-in skills contribution registers under. */
export const SKILLS_CONTRIBUTION_ID = 'namzu.skills'

/**
 * Skills, as a contribution.
 *
 * `static`, because a run's skill set is fixed for the run — a STEP's
 * skills are a different thing entirely and ride the ephemeral trailing
 * system message, which is what keeps them out of the cached prefix.
 *
 * The persona path does not use this. `assembleSystemPrompt(persona,
 * skills)` renders skills INSIDE the persona's own section ordering, which
 * is a persona-assembler decision about where skills belong relative to
 * constraints and output discipline. Moving it out here would silently
 * reorder every persona-driven prompt in the estate to buy uniformity
 * nobody asked for. So this contribution serves the branches that render
 * skills standalone, and the persona branch keeps its own — stated here
 * because two renderers for one concept is exactly the kind of thing that
 * looks like an oversight later.
 */
export const skillsContribution: PromptContribution = {
	id: SKILLS_CONTRIBUTION_ID,
	placement: 'static',
	render: (context) => renderSkillsSection(context.skills ? [...context.skills] : undefined),
}
