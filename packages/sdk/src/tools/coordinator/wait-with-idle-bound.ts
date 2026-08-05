import type { TaskGateway, TaskHandle } from '../../types/agent/gateway.js'
import type { TaskId } from '../../types/ids/index.js'

/**
 * Waiting on a delegated worker, bounded by two different questions.
 *
 * A wall clock alone is the wrong instrument. It has to be long enough to
 * serve as the outer bound for a child doing real work — an hour, here — and
 * that is far too long to notice a child that wedged in its second minute.
 * The same number cannot be both "how long is too long" and "how quiet is too
 * quiet", so this keeps them apart:
 *
 *  - the **run bound** counts elapsed time and is never refreshed. It exists
 *    for a worker that stays busy forever.
 *  - the **idle bound** counts time since the worker last did anything, and
 *    resets whenever it does. It exists for a worker that stopped.
 *
 * Whichever fires first ends the wait, and the result says WHICH — because
 * "it went quiet" and "it ran too long" are different diagnoses and lead to
 * different next moves. Telling a caller its worker timed out when the worker
 * was making steady progress is the failure this replaces.
 *
 * The idle bound is only armed when the gateway can report progress.
 * `onTaskProgress` is optional on the contract, because hosts implement
 * `TaskGateway` and not all of them can observe their children — so a gateway
 * without it is bounded by the wall clock alone, exactly as before. That is a
 * real degradation and it is deliberately visible in the result rather than
 * silent: `idleBoundArmed` says whether the quieter half was ever watching.
 */
export type WaitOutcome =
	| { readonly kind: 'completed'; readonly handle: TaskHandle }
	| {
			readonly kind: 'timeout'
			/** Which clock ran out. */
			readonly cause: 'idle' | 'run'
			readonly elapsedMs: number
			/** False when the gateway cannot report progress, so only the wall clock applied. */
			readonly idleBoundArmed: boolean
	  }

export interface WaitBounds {
	/** Elapsed-time ceiling, never refreshed. */
	readonly runMs: number
	/**
	 * Time-without-progress ceiling, refreshed on every progress signal.
	 *
	 * Omit to bound by the run clock alone.
	 */
	readonly idleMs?: number
}

/**
 * Await a task under both bounds.
 *
 * Note what this does NOT do: it does not cancel the worker. A wait that ran
 * out is a statement about the waiter, not about the work — the child keeps
 * going, its completion still reaches the inbox, and the supervisor is still
 * told what it produced. Killing a child because a parent stopped waiting was
 * never asked for, and losing an eight-minute worker's output because a
 * two-minute clock expired is the exact shape of the bug this whole area has
 * been unpicking.
 */
export async function waitForTaskWithBounds(
	gateway: TaskGateway,
	taskId: TaskId,
	bounds: WaitBounds,
	now: () => number = Date.now,
): Promise<WaitOutcome> {
	const startedAt = now()
	let lastProgressAt = startedAt
	let settled = false

	const detach = gateway.onTaskProgress?.((id) => {
		if (id === taskId) lastProgressAt = now()
	})
	const idleBoundArmed = detach !== undefined && bounds.idleMs !== undefined

	try {
		const completion = gateway.waitForTask(taskId).then(
			(handle): WaitOutcome => ({ kind: 'completed', handle }),
			// A gateway that rejects has answered the question; let it through
			// rather than reporting a timeout that did not happen.
			(err) => {
				throw err
			},
		)

		const expiry = new Promise<WaitOutcome>((resolve) => {
			// Polled rather than scheduled, because the idle deadline MOVES: a
			// timer armed for it would have to be cleared and rearmed on every
			// tick of progress, and the one that slipped through would be the
			// one that mattered. A coarse tick is enough — these bounds are
			// minutes, and being a second late to notice silence costs nothing.
			const tick = setInterval(() => {
				if (settled) return
				const elapsed = now() - startedAt
				if (elapsed >= bounds.runMs) {
					clearInterval(tick)
					resolve({ kind: 'timeout', cause: 'run', elapsedMs: elapsed, idleBoundArmed })
					return
				}
				if (idleBoundArmed && bounds.idleMs !== undefined) {
					const quietFor = now() - lastProgressAt
					if (quietFor >= bounds.idleMs) {
						clearInterval(tick)
						resolve({ kind: 'timeout', cause: 'idle', elapsedMs: elapsed, idleBoundArmed })
					}
				}
			}, POLL_INTERVAL_MS)
			// Never the reason a process stays alive. This one is safe to unref
			// where the park recorder was not, because nothing AWAITS it alone:
			// it races a real completion promise, so the wait is held open by
			// work that is genuinely outstanding rather than by this timer.
			;(tick as { unref?: () => void }).unref?.()
		})

		return await Promise.race([completion, expiry])
	} finally {
		settled = true
		detach?.()
	}
}

/**
 * How often the bounds are checked.
 *
 * Coarse on purpose: both bounds are measured in minutes, so a second of
 * latency in noticing is irrelevant, and a tight interval would spend a timer
 * wakeup per second per in-flight worker for nothing.
 */
const POLL_INTERVAL_MS = 1_000

/** What to tell the model, in the words that fit what actually happened. */
export function describeWaitTimeout(outcome: Extract<WaitOutcome, { kind: 'timeout' }>): string {
	const seconds = Math.round(outcome.elapsedMs / 1000)
	if (outcome.cause === 'idle') {
		return `This worker went quiet: nothing has come from it for a while, after ${seconds}s. It has not been cancelled and may still finish — its result will arrive as a task notification if it does. Check agent_task_list, or start a different approach.`
	}
	return outcome.idleBoundArmed
		? `This worker has been running for ${seconds}s without finishing, though it was still doing something. It has not been cancelled — its result will arrive as a task notification if it finishes.`
		: `This worker has been running for ${seconds}s without finishing. This gateway cannot report progress, so there is no way to tell a busy worker from a stuck one here. It has not been cancelled — its result will arrive as a task notification if it finishes.`
}
