import type { TaskHandle } from '../../types/agent/scheduler.js'

/**
 * Did this worker actually succeed?
 *
 * Two layers can disagree, and asking only one of them is how a failed worker
 * gets reported as an answer:
 *
 * 1. **`TaskHandle.state`** — the gateway's terminal task state. Some gateways
 *    map a failed run to `state: 'failed'`; others forward whatever the agent
 *    manager set, which does not always reflect run-level failure. The kernel's
 *    own `finalizeChild` always calls `markCompleted`, so `state` is
 *    `'completed'` for a child that ran and returned `status: 'failed'`.
 * 2. **`BaseAgentResult.status`** — the run's own status, and the canonical
 *    answer to whether the agent finished its work. `lastError` carries the
 *    message when it did not.
 *
 * So success requires BOTH to agree. Reporting a failed worker as successful
 * hands the parent garbage output as though it were a result, and makes
 * debugging impossible — the model reads an error as an answer and builds on
 * it.
 *
 * **This lives here because it was written twice and omitted once**, and the
 * omission was in `create_task`, the primary delegation surface. The version in
 * the canonical `Agent` tool was correct because a review caught it there; the
 * same review never reached the other site. A predicate that is easy to get
 * wrong, and whose wrong answer is silent, belongs in one place that every
 * caller reaches rather than in each caller's memory.
 */
export function taskSucceeded(handle: Pick<TaskHandle, 'state' | 'result'>): boolean {
	const runStatus = handle.result?.status
	return handle.state === 'completed' && (runStatus === undefined || runStatus === 'completed')
}

/**
 * Did this worker actually fail? **Not the negation of {@link taskSucceeded}.**
 *
 * Three answers exist, not two: succeeded, failed, and not settled yet. A task
 * still running satisfies neither predicate, and that is the point — a caller
 * deciding whether to tear down healthy siblings must act on a child that
 * *failed*, never on one that merely has not succeeded yet. Writing this as
 * `!taskSucceeded(handle)` would cancel a fan-out the moment the first child
 * was still working.
 *
 * The two-authority rule applies here too, for the same reason: the kernel's
 * `finalizeChild` always calls `markCompleted`, so a run that returned
 * `status: 'failed'` carries `state: 'completed'`, and a check that read only
 * the gateway state would never see it fail.
 *
 * Third copy of this knowledge, now in the one place `taskSucceeded` already
 * lives — it was written independently in `LocalTaskScheduler`, which got it
 * right, but a rule that each caller has to remember is a rule one of them
 * eventually forgets. That has already happened once with `taskSucceeded`.
 */
export function taskFailed(handle: Pick<TaskHandle, 'state' | 'result'>): boolean {
	return handle.state === 'failed' || handle.result?.status === 'failed'
}

/**
 * What to call the failure, in the words of whichever layer reported it.
 *
 * The gateway state wins when it is the one that disagrees, because a task that
 * never reached `completed` failed in a way the run status cannot describe — it
 * was cancelled, or it timed out, and saying "failed" for those loses the
 * distinction a reader needs to decide what to do next.
 */
export function failureLabel(handle: Pick<TaskHandle, 'state' | 'result'>): string {
	if (handle.state !== 'completed') return handle.state
	return handle.result?.status ?? 'failed'
}
