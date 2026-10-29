import type { ReasoningEffort } from '../provider/chat.js'

/**
 * Who may reach for a skill.
 *
 * Every skill was offered to the model and to nobody else, and the two
 * halves of that are both wrong. A skill that only an operator can
 * meaningfully run — "collect a support bundle", "rotate the deploy key" —
 * sat in the model's manifest as something to attempt, and the model would
 * attempt it. A skill that is purely model guidance had no way to be
 * offered to an operator at all.
 *
 * `both` is the default because it is what every existing skill silently
 * was, and narrowing one is a decision its author makes rather than one a
 * version bump makes for them.
 */
export type SkillInvocation = 'model' | 'operator' | 'both'

export interface SkillMetadata {
	name: string

	description: string

	license?: string

	compatibility?: string

	allowedTools?: string

	/**
	 * Who may invoke this skill. Absent means {@link SKILL_INVOCATION_DEFAULT}.
	 *
	 * Optional rather than required, so that a `SkillMetadata` written
	 * before this existed still type-checks — and resolved through
	 * {@link skillInvocation} rather than with `?? 'both'` at each reader,
	 * because the default is one decision and four copies of it is three
	 * chances to disagree.
	 */
	invocation?: SkillInvocation

	metadata?: Record<string, string>

	/**
	 * When the model should reach for the skill, in the author's words.
	 * Shown to the model next to the description (`when_to_use`); see
	 * {@link skillModelDescription}.
	 */
	whenToUse?: string

	/**
	 * Where the skill runs. `fork` hands its instructions to a delegated agent
	 * and returns that agent's report; absent or `inline` loads them into the
	 * current conversation.
	 */
	context?: 'inline' | 'fork'

	/** The delegated agent type a `fork` skill runs as (`agent`). */
	agent?: string

	/**
	 * The model a `fork` skill's delegated agent runs on (`model`). An inline
	 * skill runs on the turn's own model; this does not switch it.
	 */
	model?: string

	/**
	 * The reasoning effort requested for a `fork` skill's delegated agent
	 * (`effort`), even without `model`. The host validates the combination;
	 * this does not switch the current turn's effort for an inline skill.
	 */
	effort?: ReasoningEffort

	/** Whether a `fork` skill's agent runs in the background (`background`). */
	background?: boolean
}

/**
 * What the model reads as a skill's description: the description, then the
 * author's `when_to_use` guidance when there is one.
 */
export function skillModelDescription(metadata: {
	description: string
	whenToUse?: string
}): string {
	const description = metadata.description.trim()
	const when = metadata.whenToUse?.trim()
	return when ? `${description} - ${when}` : description
}

/** What a skill that says nothing means. */
export const SKILL_INVOCATION_DEFAULT: SkillInvocation = 'both'

/** The skill's stated policy, or the default. */
export function skillInvocation(skill: { metadata: SkillMetadata }): SkillInvocation {
	return skill.metadata.invocation ?? SKILL_INVOCATION_DEFAULT
}

/**
 * May this audience reach for this skill?
 *
 * `both` satisfies either side, which is the only reason the third value
 * exists — a two-value policy would force every author to pick a side for a
 * skill that genuinely serves both.
 */
export function isInvocableBy(
	skill: { metadata: SkillMetadata },
	audience: 'model' | 'operator',
): boolean {
	const policy = skillInvocation(skill)
	return policy === 'both' || policy === audience
}

export interface Skill {
	metadata: SkillMetadata

	body?: string

	dirPath: string
}

export type SkillDisclosureLevel = 'metadata' | 'full' | 'assets'

export interface SkillLoadResult {
	skill: Skill
	disclosureLevel: SkillDisclosureLevel

	tokenEstimate: number
}

export interface SkillChain {
	inherited: Skill[]

	own: Skill[]

	resolved: Skill[]
}
