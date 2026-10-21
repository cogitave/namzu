/**
 * A headless run and the monitors its model started.
 *
 * A monitor watches while the model works, and the model may finish its turn
 * with the watch still running. In the terminal the person is there and the
 * session wakes on the next event; a single-shot run has nobody to wake it, so
 * it would exit and the session close would stop the watch before it reported
 * anything. This waits instead: while the session owns a running monitor it
 * waits for the monitor to speak or end (the registry tells it, nothing is
 * polled), hands the model what arrived as one message, and lets it report.
 * It stops when no monitor is left, and a monitor cannot outlive its timeout
 * (`EXEC_MONITOR_CAP_MS`), so the wait is bounded by the watches themselves.
 */

import { createUserMessage } from '@namzu/sdk'
import type { Message } from '@namzu/sdk'

import type { SessionMonitors } from '../tui/agent.js'

/** How long one monitor may watch in a single-shot run (the kernel's cap is 30 minutes). */
export const EXEC_MONITOR_CAP_MS = 600_000

export interface MonitorWatch {
	/**
	 * Resolves with the text of what the monitors said since the last report, or
	 * `undefined` when none is left running and nothing is waiting. `signal`
	 * ends the wait for a signal the process received.
	 */
	report(options: { readonly signal: AbortSignal }): Promise<string | undefined>
}

export function watchMonitors(monitors: SessionMonitors | undefined): MonitorWatch | undefined {
	if (!monitors) return undefined
	return {
		async report({ signal }) {
			while (!signal.aborted) {
				if (monitors.size > 0) return monitors.take().text
				if (monitors.running() === 0) return undefined
				await new Promise<void>((resolve) => {
					const done = (): void => {
						off()
						signal.removeEventListener('abort', done)
						resolve()
					}
					// Subscribed in the same tick as the checks above, so an event
					// that lands between them cannot be missed.
					const off = monitors.onChange(done)
					signal.addEventListener('abort', done, { once: true })
				})
			}
			return undefined
		},
	}
}

/** What the monitors said, as the model receives it: runtime context, not something typed. */
export function monitorReportMessage(text: string): Message {
	return createUserMessage(text, undefined, {
		type: 'runtime-context',
		kind: 'job-exit',
	})
}
