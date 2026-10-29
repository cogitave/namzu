/**
 * Names for sub-agents. A name given to `Agent` addresses that agent in
 * `send_message`, `wait_for_task` and `cancel_agent` in place of its task id.
 */

/** Letters, digits, underscore and hyphen; starts with a letter or digit; at most 64. */
const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** Names that already address something else. */
const RESERVED = new Set(['main', 'team-lead', 'user', 'system'])

/** What an id looks like: a task UUID, or a workflow run id. Those address an agent or run directly. */
const ID_SHAPES = [
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	/^w[0-9a-z]{8}$/,
]

/** How two spellings of a name are told apart: width-folded, trimmed, lower-case, spaces as hyphens. */
export function normalizeAgentName(raw: string): string {
	return raw
		.normalize('NFKC')
		.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, (c) => (/\s/.test(c) ? c : ''))
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '-')
}

/** Why a name cannot be used, in words for the model; undefined when it can. */
export function agentNameProblem(raw: string): string | undefined {
	if (!NAME_SHAPE.test(raw))
		return 'name must start with a letter or digit and contain only letters, digits, underscores or hyphens (at most 64 characters).'
	const folded = normalizeAgentName(raw)
	if (RESERVED.has(folded))
		return `"${raw}" is reserved. Pick another name; "main" is how a sub-agent reaches the main conversation.`
	if (ID_SHAPES.some((shape) => shape.test(raw)))
		return 'name must not look like a task or run id, which already address an agent directly.'
	return undefined
}

/** Names keyed by conversation; a task id still has one globally unique owner. */
export class AgentNames {
	private readonly byName = new Map<string, { name: string; taskId: string }>()

	/** A later agent in the same conversation takes the name over. */
	register(name: string, taskId: string, conversation = ''): void {
		this.byName.set(JSON.stringify([conversation, normalizeAgentName(name)]), { name, taskId })
	}

	/** The task a name addresses, or undefined when it names none. */
	resolve(asked: string, conversation = ''): string | undefined {
		return this.byName.get(JSON.stringify([conversation, normalizeAgentName(asked)]))?.taskId
	}

	/** The name an agent was given, if any. */
	nameOf(taskId: string): string | undefined {
		let found: string | undefined
		for (const entry of this.byName.values()) if (entry.taskId === taskId) found = entry.name
		return found
	}

	/** Forget every name of an agent that is gone. */
	forget(taskId: string): void {
		for (const [key, entry] of this.byName) if (entry.taskId === taskId) this.byName.delete(key)
	}
}
