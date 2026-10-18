/**
 * What the model is told on a turn that offers the `workflow` tool, beside the
 * delegation doctrine. Said only when the tool is in the list: guidance about
 * a capability the turn does not have reads as one it should go looking for.
 */
export const WORKFLOW_DOCTRINE = [
	'The `workflow` tool is available this turn because the operator asked for orchestration.',
	'Use it for work with several phases or many agents: write the script once, call `workflow`, and the runtime schedules the agents and groups them by phase. Keep `Agent` calls (with a `workflow` label and a `phase`) for a small fan-out of a few agents, and for a single subagent.',
	'A workflow runs in the background and the operator approves the script before it starts. After you start one, tell the operator in one sentence that it is running; its result reaches you in a single message when it ends, and you then report the outcome.',
].join('\n')
