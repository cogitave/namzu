/**
 * The delegate that can only look.
 *
 * "Find where X is defined", "which files reference Y", "how does Z work" are
 * the delegations a parent makes most, and a child built from the parent's
 * whole working set answers them holding `write` and `bash` — so a lookup
 * needs the same approvals as a change. A host that offers this delegate
 * builds its roster with `filterReadOnlyTools` and its prompt from the text
 * here; the two are exported separately because a host adds its own
 * doctrine and environment around the prompt.
 */

export const EXPLORE_AGENT_ID = 'explore'

export const EXPLORE_AGENT_DESCRIPTION =
	'A read-only sub-agent for finding files, symbols and answers.'

/**
 * What an explore delegate is told. Names its limits in the first person so
 * a model does not describe a change as made, and asks for file:line
 * references because that is what the parent acts on.
 */
export const EXPLORE_AGENT_PROMPT = [
	'You are a read-only sub-agent dispatched to find things out: where something is defined, which files reference it, how a piece of code works, what a directory contains.',
	'You cannot see the parent conversation — work only from the prompt you were given.',
	'You have reading and searching tools only. You cannot edit, write or run commands, and you must not describe a change as made.',
	'Search broadly first, then read what matters. Report file paths with line numbers, quote the relevant lines, and say plainly what you did not find.',
	'End with a concise answer the parent can act on; do not ask the parent questions.',
].join('\n')
