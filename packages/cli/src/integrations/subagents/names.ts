/**
 * Names for delegated agents, chosen by purpose.
 *
 * Two agents of one type used to read identically on the rail
 * (`general-purpose` twice). An agent now carries a short name for its job:
 * the one the model passed to the `Agent` tool, or else a slug taken from the
 * first meaningful words of its `description`. Names are unique among the
 * agents that are still running, and the same name addresses the agent in
 * `send_message`, `cancel_agent` and `wait_for_task`.
 *
 * Pure functions only; the monitor owns which names are taken.
 */

/** Longest name; the width of the rail's name column. */
export const MAX_AGENT_NAME_LENGTH = 28

/** Meaningful words kept from a description. */
const FALLBACK_WORDS = 4

/** `count-words`, `audit-auth-2`: lowercase words joined by single hyphens. */
export const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const RESERVED_NAMES: ReadonlySet<string> = new Set([
	'main',
	'user',
	'system',
	'parent',
	'operator',
	'assistant',
])

const STOP_WORDS: ReadonlySet<string> = new Set([
	'a',
	'an',
	'the',
	'in',
	'on',
	'of',
	'to',
	'for',
	'and',
	'or',
	'with',
	'from',
	'by',
	'at',
	'all',
	'any',
	'this',
	'that',
	'these',
	'those',
	'my',
	'our',
	'your',
	'it',
	'its',
	'is',
	'are',
	'be',
	'as',
	'into',
	'then',
	'also',
	'please',
])

/**
 * A name that would be mistaken for an identifier this host already issues:
 * a view id (`agent-3`), a dynamic specialist (`dyn-1`), a task UUID, or a
 * workflow run id (`w` and eight characters, which `wait_for_task` answers
 * differently).
 */
export function isIdShapedName(name: string): boolean {
	return (
		/^(?:agent|dyn|task|run|workflow)-\d+$/.test(name) ||
		/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(name) ||
		/^w[0-9a-z]{8}$/.test(name)
	)
}

/** Why `name` cannot be used, in words the model can act on; undefined when it can. */
export function agentNameProblem(name: string): string | undefined {
	if (name.length === 0) return 'The agent name must not be empty.'
	if (name.length > MAX_AGENT_NAME_LENGTH)
		return `The agent name "${name}" is longer than ${MAX_AGENT_NAME_LENGTH} characters. Use a short name for the job, for example "count-words".`
	if (!AGENT_NAME_PATTERN.test(name))
		return `The agent name "${name}" must be lowercase words joined by hyphens, for example "count-words".`
	if (RESERVED_NAMES.has(name)) return `"${name}" is reserved. Pick a name for this agent's job.`
	if (isIdShapedName(name))
		return `"${name}" looks like an identifier this host issues. Pick a name for this agent's job.`
	return undefined
}

/**
 * A slug from the first three or four meaningful words of a description, or
 * undefined when none survive (an empty description, or one with no letters
 * a-z or digits). `Count words in a.txt` becomes `count-words-txt`.
 */
export function nameFromDescription(description: string): string | undefined {
	const words = description
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 0 && !STOP_WORDS.has(word))
	let slug = ''
	for (const word of words.slice(0, FALLBACK_WORDS)) {
		const next = slug ? `${slug}-${word}` : word
		if (next.length > MAX_AGENT_NAME_LENGTH) break
		slug = next
	}
	if (!slug && words[0]) slug = words[0].slice(0, MAX_AGENT_NAME_LENGTH)
	return slug.length > 0 ? slug : undefined
}

/** A type id as a name: `General Purpose` and `explore` both become slugs. */
export function nameFromType(type: string): string {
	return (
		type
			.normalize('NFKD')
			.replace(/\p{M}/gu, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, MAX_AGENT_NAME_LENGTH)
			.replace(/-+$/g, '') || 'agent'
	)
}

/**
 * `base` if it is free, else `base-2`, `base-3`, ... The base is trimmed first
 * so the suffix never pushes the name past {@link MAX_AGENT_NAME_LENGTH}.
 */
export function uniqueAgentName(base: string, taken: (candidate: string) => boolean): string {
	const free = (candidate: string): boolean => !taken(candidate) && !isIdShapedName(candidate)
	if (free(base)) return base
	for (let counter = 2; ; counter += 1) {
		const suffix = `-${counter}`
		const stem = base.slice(0, MAX_AGENT_NAME_LENGTH - suffix.length).replace(/-+$/g, '')
		const candidate = `${stem}${suffix}`
		if (free(candidate)) return candidate
	}
}
