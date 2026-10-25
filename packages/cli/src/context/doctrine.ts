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

export {
	CODING_AGENT_DELEGATION_DOCTRINE as NAMZU_DELEGATION_DOCTRINE,
	CODING_AGENT_WORKING_DOCTRINE as NAMZU_WORKING_DOCTRINE,
	PLAN_MODE_DOCTRINE as NAMZU_PLAN_MODE_DOCTRINE,
} from '@namzu/sdk'

/**
 * Plan mode in a session that has the plan file and `exit_plan_mode` (the
 * interactive terminal). The kernel's `PLAN_MODE_DOCTRINE` tells a host with
 * neither to reply with the plan and stop; this one tells the model the plan
 * goes in a file and is put up with the tool. The detail — the path, the
 * steps — rides in the plan-mode reminder, which is also what covers a switch
 * made while a reply is already running.
 */
export const NAMZU_PLAN_FILE_DOCTRINE = `## Plan mode

You are in plan mode. Read, search and think; the only file you may change is the plan file named in the plan-mode reminder. Any other \`edit\`, \`write\` or shell command that changes state will be refused. Write the plan into the plan file, then call \`exit_plan_mode\` so the user can approve it; do not ask for approval in plain text. If the user sends you back with feedback, revise the plan file and call it again.`
