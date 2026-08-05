import type { TaskHandle } from '../../types/agent/gateway.js'

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
