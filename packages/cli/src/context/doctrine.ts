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
 * is in `plan` mode.
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
