/**
 * What the model is told about ending work it started. One place, so the
 * stop tool, the Agent and workflow texts and the system prompt say the same
 * thing in the same words.
 */

/** A workflow run id as `agent_task_list` shows it: `w` and eight characters. */
export const WORKFLOW_RUN_ID = /^w[0-9a-z]{8}$/

/** When to end background work, and what to say about it. */
export const STOP_WORK_GUIDANCE =
	'Background work you started is yours to end once it no longer serves the task: stop it when the person changed course, when a result already in hand answers the question, or when an earlier stage failed so the rest is pointless. Do not stop work that is only slow; a task agent_task_list labels stalled or dead is a candidate. Say in one sentence what you stopped and why.'

/** What to do when the person says to continue and a run of this conversation did not finish. */
export const CONTINUE_RUN_GUIDANCE =
	'When the person says to continue and a workflow run of this conversation was stopped, failed or cut short unfinished (a notice says so, or agent_task_list names it), resume it with workflow and resumeFromRunId, which reuses the agents that finished, instead of redoing its work by hand or starting a fresh run. Say in one line that you are resuming it.'

/** The `stop_task` tool's own description. */
export const STOP_TASK_DESCRIPTION = `Stop work you started in this conversation: an agent task (by task ID or name) or a workflow run (by run ID, the run_id agent_task_list returns). A run's running agents are aborted and its queued agents never start; what finished is kept, so a later workflow call with resumeFromRunId reuses it. An agent or run that already ended answers "already ended". Acceptance is not proof of termination; check agent_task_list or wait_for_task for the outcome. Background shell jobs and monitors are ended with the job tool (kill), not this one. ${STOP_WORK_GUIDANCE} ${CONTINUE_RUN_GUIDANCE}`
