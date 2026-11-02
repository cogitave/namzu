/**
 * An idle bound for a blocking wait on a delegated agent.
 *
 * The wait ends early when the agent has shown no activity for `idleMs`, so a
 * child that went quiet is reported as such instead of holding the parent's
 * turn for as long as it stays silent. Only the wait ends: the agent keeps
 * running and its result still arrives as a task notification.
 *
 * The clock and the progress reading are passed in, so a test advances fake
 * timers instead of waiting.
 */

import { LIVENESS_STALLED_MS } from '@namzu/sdk'

export interface IdleWatchOptions {
	/** Silence that ends the wait, in milliseconds. Defaults to the kernel's idle bound. */
	readonly idleMs?: number
	/** When the agent last showed activity; `undefined` when it cannot be told (no bound then). */
	readonly lastProgressAt: () => number | undefined
	readonly now?: () => number
	/** How often silence is checked. */
	readonly pollMs?: number
}

export interface IdleWatch {
	/** Resolves when the silence reaches the bound. Stops checking when `signal` aborts. */
	readonly wait: (signal: AbortSignal) => Promise<void>
	/** How long the agent had been silent when the bound tripped; `undefined` if it did not. */
	readonly quietForMs: () => number | undefined
}

export function createIdleWatch(options: IdleWatchOptions): IdleWatch {
	const idleMs = options.idleMs ?? LIVENESS_STALLED_MS
	const now = options.now ?? Date.now
	const pollMs = options.pollMs ?? 1_000
	let tripped: number | undefined
	return {
		quietForMs: () => tripped,
		wait: (signal) =>
			new Promise<void>((resolve) => {
				if (signal.aborted) return
				const timer = setInterval(() => {
					const last = options.lastProgressAt()
					if (last === undefined) return
					const quiet = now() - last
					if (quiet < idleMs) return
					tripped = quiet
					clearInterval(timer)
					signal.removeEventListener('abort', stop)
					resolve()
				}, pollMs)
				const stop = (): void => clearInterval(timer)
				signal.addEventListener('abort', stop, { once: true })
				;(timer as { unref?: () => void }).unref?.()
			}),
	}
}

/** What the model reads when a wait ended because the agent went quiet. */
export function describeQuietTask(taskId: string, quietForMs: number, queued: boolean): string {
	const seconds = Math.round(quietForMs / 1000)
	return `Task ${taskId} ${queued ? 'is still queued' : 'is still running'} but went quiet: no activity from it for ${seconds}s. It has not been stopped and may still be working; its result will arrive as a task notification. agent_task_list shows what it did last.`
}
