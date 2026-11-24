/**
 * Names of teams and their members. A member's name is how the others address it (`send_message`
 * `to`), and it is also a file name under the team's directory, so the rules are strict.
 *
 * @experimental
 */

/** Letters, digits, underscore and hyphen; starts with a letter or digit; at most 64. */
const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** Names that already address something else. `lead` is the conversation the person talks to. */
const RESERVED = new Set(['lead', 'main', 'team-lead', 'user', 'system'])

/** What an id looks like: a task UUID, or a workflow run id. Those address an agent or run directly. */
const ID_SHAPES = [
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	/^w[0-9a-z]{8}$/,
]

/** The name every member and the lead is addressed by when the recipient is the main conversation. */
export const TEAM_LEAD_NAME = 'lead'

/** How two spellings of a name are told apart: width-folded, trimmed, lower-case, spaces as hyphens. */
export function normalizeTeamName(raw: string): string {
	return raw
		.normalize('NFKC')
		.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, (c) => (/\s/.test(c) ? c : ''))
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '-')
}

/** Why a member name cannot be used, in words for the model; undefined when it can. */
export function teammateNameProblem(raw: string): string | undefined {
	if (!NAME_SHAPE.test(raw))
		return 'name must start with a letter or digit and contain only letters, digits, underscores or hyphens (at most 64 characters).'
	if (RESERVED.has(normalizeTeamName(raw)))
		return `"${raw}" is reserved. Pick another name; "lead" is how a teammate reaches the main conversation.`
	if (ID_SHAPES.some((shape) => shape.test(raw)))
		return 'name must not look like a task or run id, which already address an agent directly.'
	return undefined
}

/** Why a team name cannot be used as a directory name; undefined when it can. */
export function teamNameProblem(raw: string): string | undefined {
	if (!NAME_SHAPE.test(raw))
		return 'team name must start with a letter or digit and contain only letters, digits, underscores or hyphens (at most 64 characters).'
	return undefined
}
