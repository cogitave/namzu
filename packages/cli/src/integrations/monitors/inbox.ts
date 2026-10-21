/**
 * What a session's monitors said while no turn was reading.
 *
 * The kernel delivers a monitor's events inside a running turn, on the next
 * tool result, and tells the host which ones it actually put in front of the
 * model. Everything else is the host's: an event that arrives between turns,
 * or after the last tool result of one, must reach the model some other way,
 * and must not reach it twice. This is that ledger, shared by every host that
 * owns a session (the terminal, a single-shot run, ACP), so the rule is written
 * once.
 *
 * Pure of I/O: it holds text and ids. The text is the kernel's own
 * system-event rendering (`formatMonitorEvent`, `formatMonitorEnd`,
 * `capMonitorNotifications`), with the watched command's output inside the
 * untrusted frame.
 */

import {
	type BackgroundJob,
	type MonitorEvent,
	capMonitorNotifications,
	formatMonitorEnd,
	formatMonitorEvent,
} from '@namzu/sdk'

/** A monitor event with the command it watches, which the envelope names as its source. */
export type SessionMonitorEvent = MonitorEvent & { readonly command: string }

/** The envelope for one batch of a monitor's output, or one of its own notices: the kernel's own text. */
export function monitorEventText(event: SessionMonitorEvent): string {
	return formatMonitorEvent(event, event.command)
}

/** The envelope for a monitor's end: the kernel's own text. */
export function monitorEndText(
	job: BackgroundJob,
	stats: { readonly stdoutChars: number },
): string {
	return formatMonitorEnd(job, stats)
}

interface Entry {
	readonly text: string
	/** Whether an idle host should start a turn for it (a stop the operator asked for does not). */
	readonly wakes: boolean
}

export interface MonitorInbox {
	/** A batch of output, or a notice the monitor wrote. Ignored when already delivered. */
	addEvent(event: SessionMonitorEvent): void
	/** A monitor ended. `operatorStopped` ends are kept for the next turn but never wake one. */
	addEnd(job: BackgroundJob, stats: { readonly stdoutChars: number }): void
	/** The kernel put these ids in front of the model; they are never offered again. */
	acknowledge(ids: readonly string[]): void
	/** Everything not yet delivered, without taking it. */
	peek(): { readonly ids: readonly string[]; readonly text?: string }
	/** Everything not yet delivered, taken: it will not be offered again. */
	take(): { readonly ids: readonly string[]; readonly text?: string }
	/** Whether anything pending should start a turn by itself. */
	wakes(): boolean
	readonly size: number
	/** Told whenever something arrives, so a waiting host looks again. */
	onChange(listener: () => void): () => void
}

export function createMonitorInbox(): MonitorInbox {
	const pending = new Map<string, Entry>()
	// An id the kernel acknowledged before the host's own listener saw it
	// (subscription order differs between hosts) must not be added afterwards.
	const delivered = new Set<string>()
	const listeners = new Set<() => void>()
	const changed = (): void => {
		for (const listener of [...listeners]) {
			try {
				listener()
			} catch {
				// A listener cannot make the ledger stop.
			}
		}
	}
	// Rendered and bounded exactly as the kernel bounds an in-turn delivery:
	// whole events, the middle of a pile-up announced and dropped. What is
	// handed over is therefore everything pending, so every id is taken with
	// it; the ledger never keeps back an event the text did not carry.
	const render = (): { ids: string[]; text?: string } => {
		if (pending.size === 0) return { ids: [] }
		return {
			ids: [...pending.keys()],
			text: capMonitorNotifications([...pending.values()].map((entry) => entry.text).join('\n')),
		}
	}
	return {
		addEvent(event) {
			if (delivered.has(event.id)) return
			pending.set(event.id, { text: monitorEventText(event), wakes: true })
			changed()
		},
		addEnd(job, stats) {
			if (delivered.has(job.id)) return
			pending.set(job.id, {
				text: monitorEndText(job, stats),
				// A stop is reported with the next turn but starts none. Expiry and
				// too-much-output also end `killed`, yet each sent a notice event
				// first, which is what wakes the host.
				wakes: job.stopReason !== 'stopped' && job.status !== 'killed',
			})
			changed()
		},
		acknowledge(ids) {
			let any = false
			for (const id of ids) {
				delivered.add(id)
				any = pending.delete(id) || any
			}
			if (any) changed()
		},
		peek: render,
		take() {
			const taken = render()
			for (const id of taken.ids) {
				delivered.add(id)
				pending.delete(id)
			}
			return taken
		},
		wakes: () => [...pending.values()].some((entry) => entry.wakes),
		get size() {
			return pending.size
		},
		onChange(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
	}
}
