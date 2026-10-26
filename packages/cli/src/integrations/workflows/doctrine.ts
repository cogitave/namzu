/**
 * What the model is told, beside the delegation doctrine, whenever the
 * `workflow` tool is in its list. The tool is listed on every turn of a host
 * that can run one, so this is the opt-in rule: stable text, so it does not
 * change the cached prefix from one message to the next.
 */
export const WORKFLOW_DOCTRINE = [
	'The `workflow` tool starts many agents on one decision, and its description lists the opt-ins that allow a call. Without one, use `Agent` for a single subagent or a small fan-out of a few agents, even when the task would clearly benefit from parallelism.',
	'When hypermode is on (a note from Namzu confirms it), that is a standing opt-in for every substantive task, and you work alone only on conversational or trivial turns.',
	'Use `workflow` for work with several phases or many agents: write the script once, call `workflow`, and the runtime schedules the agents and groups them by phase. A workflow runs in the background and the operator approves the script before it starts. After you start one, tell the operator in one sentence that it is running; its result reaches you in a single message when it ends, and you then report the outcome.',
].join('\n')
