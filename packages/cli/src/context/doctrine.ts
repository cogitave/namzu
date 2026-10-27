/**
 * How namzu works, as text the model reads.
 *
 * The rules themselves live in the kernel — `CODING_AGENT_WORKING_DOCTRINE`,
 * `CODING_AGENT_DELEGATION_DOCTRINE`, `PLAN_MODE_DOCTRINE` in
 * `@namzu/sdk` — because none of them is about this application: every one
 * names a builtin tool or a behaviour any coding agent built on the kernel
 * wants, and a second host would otherwise copy the text and let it drift.
 * What stays here is the identity block in `tui/agent.ts`, which says WHO
 * this agent is and what it must never claim, and the decision of which text
 * reaches which reader: the working doctrine goes to the parent and to every
 * delegated sub-agent; the delegation doctrine, which names `task_create` and
 * `Agent`, goes to the parent only; the plan-mode text only while the session
 * is in `plan` mode. The hypermode text is not part of the system prompt: it
 * travels as request-only context (`tui/hypermode.ts`), so switching the mode
 * does not change the cached prefix.
 *
 * These are joined as raw strings into the system prompt rather than
 * registered as the kernel's contribution, because the CLI's prompt is one
 * string in a fixed order — identity, doctrine, environment, memory — and the
 * contribution would land after the environment and memory blocks.
 */

import { CODING_AGENT_WORKING_DOCTRINE as WORKING_DOCTRINE } from '@namzu/sdk'

export {
	CODING_AGENT_DELEGATION_DOCTRINE as NAMZU_DELEGATION_DOCTRINE,
	CODING_AGENT_WORKING_DOCTRINE as NAMZU_WORKING_DOCTRINE,
	PLAN_MODE_DOCTRINE as NAMZU_PLAN_MODE_DOCTRINE,
} from '@namzu/sdk'

/**
 * The working rules a delegated sub-agent reads: the same rules, with each
 * place that sends the reader to a person said as what to do when nobody can
 * answer. A sub-agent has no one to ask, so a rule that says "ask" would have
 * two homes beside the statement of what to do instead.
 */
const NO_ONE_TO_ASK: ReadonlyArray<readonly [string, string]> = [
	[
		'Reserve blocking questions for cases where proceeding under any assumption would be unsafe or would make the work useless if wrong.',
		'Where proceeding under any assumption would be unsafe or would make the work useless if wrong, leave that step undone and name it in your summary.',
	],
	[
		'Ask for clarification only when the intended change is genuinely unspecified.',
		'When the intended change is genuinely unspecified, take the most conservative reading and state it.',
	],
	[
		"stop and ask rather than stashing, committing or discarding somebody else's work.",
		"leave them alone: do not stash, commit or discard somebody else's work.",
	],
	[
		'make the routine judgment calls yourself and check in only when different readings would produce materially different work.',
		'make the routine judgment calls yourself, and where different readings would produce materially different work, take the most conservative one and state it.',
	],
	['without asking: not', 'unless the task says so: not'],
	[
		'stop and tell the user the command to set one; do not invent one.',
		'stop, do not invent one, and name the command that sets one in your summary.',
	],
]

function withoutAsking(doctrine: string): string {
	let out = doctrine
	for (const [from, to] of NO_ONE_TO_ASK) {
		if (!out.includes(from)) {
			throw new Error(`The working rules no longer contain: ${from}`)
		}
		out = out.replace(from, to)
	}
	return out
}

/**
 * A sub-agent reports to its parent, not to the person, so the section about
 * keeping the person informed (progress lines, a short closing note) is
 * replaced by one about the final report: complete, and without filler.
 */
const INFORMED_HEADING = '### Keeping the user informed'
const CHILD_REPORT_SECTION = `### Your final report
- Your parent reads your final report and not your tool calls, so put everything it needs there: what changed, what was verified, what is left, and every assumption you made.
- Keep the report complete and free of filler, because your parent relays it onward.`

function withChildReport(doctrine: string): string {
	const at = doctrine.indexOf(INFORMED_HEADING)
	if (at === -1) throw new Error(`The working rules no longer contain: ${INFORMED_HEADING}`)
	return `${doctrine.slice(0, at)}${CHILD_REPORT_SECTION}`
}

export const NAMZU_CHILD_WORKING_DOCTRINE: string = withChildReport(withoutAsking(WORKING_DOCTRINE))

/**
 * Plan mode in a session that has the plan file and `exit_plan_mode` (the
 * interactive terminal). The kernel's `PLAN_MODE_DOCTRINE` tells a host with
 * neither to reply with the plan and stop; this one tells the model the plan
 * goes in a file and is put up with the tool. The detail — the path, the
 * steps — rides in the plan-mode reminder, which is also what covers a switch
 * made while a reply is already running.
 */
export const NAMZU_PLAN_FILE_DOCTRINE = `## Plan mode

You are in plan mode. Read, search and think; the only file you may change is the plan file named in the plan-mode reminder. Any other \`edit\`, \`write\` or shell command that changes state will be refused. Write the plan into the plan file, then call \`exit_plan_mode\` so the user can approve it; a plain-text question cannot be answered in the approval screen. If the user sends you back with feedback, revise the plan file and call it again.`
