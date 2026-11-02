import { frameNotice } from '../../types/message/notice-frame.js'
import type { ToolCallOutcome } from './executor.js'

/**
 * Tool calls that were still running when the operator wrote.
 *
 * A model cannot answer while a `tool_use` block has no `tool_result`, and a
 * long call used to hold the operator's question until it finished: the person
 * asked how things stand and heard nothing for as long as the call took. When
 * the operator writes while a call has been running for a while, the batch
 * answers the unfinished calls with a placeholder result, the model reads the
 * message at once, and the call carries on untouched. Its real result reaches
 * the model later as a message of its own that names the call.
 *
 * This holds the bookkeeping for one turn: which calls were handed back this
 * way, and the outcomes that have arrived since.
 */

/** How long a call must have been running before an operator message detaches it. */
export const DETACH_AFTER_MS = 2_000

/**
 * What a model reads as the result of a call that is still running.
 *
 * It says the call goes on, what not to do about it, and what to tell the
 * person; the model never sees these words as anything the tool printed.
 */
export function stillRunningResult(toolName: string, started = true): string {
	if (!started) {
		return [
			`[Waiting to start] The ${toolName} call has not started: it is queued behind an earlier call in this batch. The operator wrote a message while the batch ran, and that message follows so you can answer it now.`,
			'The call will start by itself when the earlier one ends, and its result will arrive in a later message that names this call id.',
			'Repeating the call would run the work twice, and waiting or polling for it would delay your answer, so do neither. If they ask, say it has not started yet.',
		].join('\n')
	}
	return [
		`[Still running] The ${toolName} call has not finished. The operator wrote a message while it ran, and that message follows so you can answer it now.`,
		'The call was not interrupted. Its result will arrive on its own, in a later message that names this call id.',
		'Repeating the call would run the work twice, and waiting or polling for it would delay your answer, so do neither.',
		'You cannot stop it from here, so do not say you cancelled or dropped it. On the operator’s screen it still shows as in progress; if they ask, say it is still running.',
	].join('\n')
}

/** What a model reads when a call it was told was still running has finished. */
export function formatLateResults(outcomes: readonly ToolCallOutcome[]): string {
	const parts = outcomes.map(
		(outcome) =>
			`The ${outcome.toolName} call with id ${outcome.toolCallId}, which you were told was still running, has finished${outcome.isError ? ' with an error' : ''}. This is what it returned:\n${outcome.output}`,
	)
	return frameNotice('job', '[Tool call finished]', parts.join('\n\n'))
}

export class DetachedCalls {
	private readonly open = new Map<string, string>()
	private arrived: ToolCallOutcome[] = []
	private readonly waiters = new Set<() => void>()

	/**
	 * `waitForOperator` resolves when the operator wrote and at no other wake: a
	 * child's notice or a peer's mail must not hand a call back, because the
	 * model would then get a turn with no question to answer.
	 */
	constructor(readonly waitForOperator?: (signal: AbortSignal) => Promise<void>) {}

	/** A call was answered with the placeholder and is still running. */
	begin(toolCallId: string, toolName: string): void {
		this.open.set(toolCallId, toolName)
	}

	/** The real outcome of a detached call. Ignored for a call that was never detached. */
	settle(outcome: ToolCallOutcome): void {
		if (!this.open.delete(outcome.toolCallId)) return
		this.arrived.push(outcome)
		this.wake()
	}

	/** True while a call is still running or its outcome has not been read. */
	get hasWork(): boolean {
		return this.open.size > 0 || this.arrived.length > 0
	}

	/** Calls still running. */
	get running(): number {
		return this.open.size
	}

	/** The outcomes that have arrived since the last read, in arrival order. */
	take(): readonly ToolCallOutcome[] {
		const taken = this.arrived
		this.arrived = []
		return taken
	}

	/**
	 * Resolves when an outcome is waiting, when nothing is running, after
	 * `graceMs`, or rejects when `signal` aborts. Resolving early is never
	 * delivery: the caller reads with {@link take}.
	 */
	waitForArrival(graceMs: number, signal: AbortSignal): Promise<void> {
		if (this.arrived.length > 0 || this.open.size === 0) return Promise.resolve()
		if (signal.aborted) return Promise.reject(signal.reason)
		return new Promise<void>((resolve, reject) => {
			const done = (): void => {
				clearTimeout(timer)
				this.waiters.delete(wake)
				signal.removeEventListener('abort', abort)
			}
			const wake = (): void => {
				done()
				resolve()
			}
			const abort = (): void => {
				done()
				reject(signal.reason)
			}
			const timer = setTimeout(wake, Math.max(0, graceMs))
			this.waiters.add(wake)
			signal.addEventListener('abort', abort, { once: true })
		})
	}

	private wake(): void {
		for (const wake of [...this.waiters]) wake()
	}
}

/**
 * What one batch needs to hand its unfinished calls back. `requested` settles
 * once the operator has written and the batch has run for {@link DETACH_AFTER_MS};
 * `calls` receives each call that was handed back and, later, its outcome.
 */
export interface BatchDetach {
	readonly requested: Promise<void>
	readonly calls: DetachedCalls
}
