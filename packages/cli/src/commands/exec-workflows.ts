/**
 * A headless run and the workflows its model started.
 *
 * `namzu exec` used to end with its first turn, and closing the session stops
 * every run still going, so a workflow the model started was killed before its
 * first agent could answer. A headless run now waits for the workflows to end,
 * gives the model the one message about them, lets it take a reporting turn,
 * and only then exits. Pure of any I/O of its own: both exec commands drive it.
 */

import { createUserMessage } from '@namzu/sdk'
import type { Message } from '@namzu/sdk'

import { completionNotice } from '../integrations/workflows/notice.js'
import type { SessionWorkflows } from '../tui/agent.js'

/** Reporting turns one command takes at most; a model that starts a workflow in each is cut off. */
export const MAX_REPORT_TURNS = 8

export interface WorkflowWatch {
	/**
	 * Waits for the runs that are going, then returns the single message about
	 * every run that ended since the last report, or `undefined` when nothing
	 * ended. `timeoutMs` bounds the wait (the turn limit, when one is set): at
	 * that point the runs still going are stopped and reported as stopped.
	 * `signal` ends the wait for a signal the process received.
	 */
	report(options: { readonly timeoutMs?: number; readonly signal: AbortSignal }): Promise<
		string | undefined
	>
	/** Stop listening. */
	dispose(): void
}

export function watchWorkflows(workflows: SessionWorkflows | undefined): WorkflowWatch | undefined {
	if (!workflows) return undefined
	const ended: string[] = []
	const off = workflows.onEnd(({ view }) => {
		ended.push(completionNotice(view))
	})
	return {
		async report({ timeoutMs, signal }) {
			const deadline =
				timeoutMs !== undefined && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
			const bound = deadline ? AbortSignal.any([signal, deadline]) : signal
			await workflows.idle(bound)
			if (signal.aborted) return undefined
			if (deadline?.aborted) {
				// Out of time: what is still going is stopped, and says so in its report.
				for (const run of workflows.runs()) if (run.status === 'running') workflows.stop(run.runId)
				await workflows.idle(signal)
			}
			if (ended.length === 0) return undefined
			return ended.splice(0).join('\n\n')
		},
		dispose: off,
	}
}

/** The report as the model receives it: runtime context, not something the person typed. */
export function reportMessage(text: string): Message {
	return createUserMessage(text, undefined, { type: 'runtime-context', kind: 'task-completion' })
}
