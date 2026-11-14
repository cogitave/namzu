/**
 * What the model is told, beside the delegation doctrine, whenever the
 * `workflow` tool is in its list. The tool is listed on every turn of a host
 * that can run one, so this is the opt-in rule: stable text, so it does not
 * change the cached prefix from one message to the next.
 */
export const WORKFLOW_DOCTRINE = [
	'The `workflow` tool starts many agents on one decision, and its description lists the opt-ins that allow a call. Without one, use `Agent` for a single subagent or a small fan-out of a few agents. When hypermode is on (a note from Namzu confirms it), that is a standing opt-in for every substantive task, and you work alone only on conversational or trivial turns.',
	'A workflow runs in the background once the operator approves its script; tell the operator in one sentence that it is running. When the operator asks how a workflow is going, read its state with one `agent_task_list` call (set `run_id`) or the running-work note, not the launch message, which is only a receipt, and say it is still running until its message has arrived.',
].join('\n')
