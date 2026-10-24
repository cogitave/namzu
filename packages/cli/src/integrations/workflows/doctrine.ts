/**
 * What the model is told, beside the delegation doctrine, whenever the
 * `workflow` tool is in its list. The tool is listed on every turn of a host
 * that can run one, so this is the opt-in rule: stable text, so it does not
 * change the cached prefix from one message to the next.
 */
export const WORKFLOW_DOCTRINE = [
	'The `workflow` tool starts many agents on one decision. Call it only after an explicit opt-in, which is one of:',
	'- the operator\'s message included the keyword "hypermode" or "workflow" (a note from Namzu confirms it for that turn);',
	'- hypermode is on for the session (a note from Namzu confirms it); then it is a standing opt-in for every substantive task, and you work alone only on conversational or trivial turns;',
	'- the operator asked for a workflow or for multi-agent orchestration in their own words, or used `/workflow`;',
	'- the operator named a specific saved workflow to run.',
	'For any other task, even one that would clearly benefit from parallelism, do not call it: use `Agent` for a single subagent or a small fan-out of a few agents.',
	'Use it for work with several phases or many agents: write the script once, call `workflow`, and the runtime schedules the agents and groups them by phase. A workflow runs in the background and the operator approves the script before it starts. After you start one, tell the operator in one sentence that it is running; its result reaches you in a single message when it ends, and you then report the outcome.',
].join('\n')
