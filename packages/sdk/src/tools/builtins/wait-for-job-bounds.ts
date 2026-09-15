import type { BackgroundJobRegistryRef } from '../../types/tool/index.js'

/**
 * Waiting on a background job, bounded by two different questions — the
 * shell-job counterpart to `waitForTaskWithBounds`
 * (`../coordinator/wait-with-idle-bound.ts`), which this mirrors.
 *
 * A delegated agent task reports its own progress through
 * `TaskScheduler.onTaskProgress`. A shell job has no such channel: the only
 * signal it ever produces is bytes on stdout/stderr. So where the task
 * version resets its idle clock on a progress EVENT, this one resets it on
 * OBSERVED OUTPUT GROWTH — read on every tick, compared against the last
 * tick's offset. A tick that finds nothing new is not progress; treating it
 * as progress would make the idle bound unable to fire for a wedged job at
 * all, which is the exact failure this exists to catch.
 *
 *  - the **run bound** counts elapsed time and is never refreshed. It
 *    exists for a job that stays busy forever (a server, a stuck build).
 *  - the **idle bound** counts time since output last grew, and resets
 *    whenever it does. It exists for a job that stopped producing anything
 *    without exiting.
 *
 * Neither bound cancels the job. A wait that ran out is a statement about
 * the WAITER, not the work — the job keeps running, and its output is still
 * there to read with `job` or a later `wait_for_job` call.
 */
export interface JobWaitOptions {
	/** Elapsed-time ceiling, never refreshed. */
	readonly runMs: number
	/**
	 * Time-without-new-output ceiling, refreshed whenever `read` returns
	 * more than it did last tick. Omit to bound by the run clock alone.
	 */
	readonly idleMs?: number
	/** Resume from here rather than the start of what the job has retained. */
	readonly fromOffset?: number
	/** Stop preempts a wait that has not resolved yet; the job is untouched. */
	readonly signal?: AbortSignal
}

interface JobWaitProgress {
	readonly output: string
	readonly nextOffset: number
	readonly droppedBytes: number
}

export type JobWaitOutcome =
	| ({
			readonly kind: 'exited'
			readonly status: string
			readonly exitCode?: number
	  } & JobWaitProgress)
	| ({
			readonly kind: 'timeout'
			/** Which clock ran out. */
			readonly cause: 'idle' | 'run'
			readonly elapsedMs: number
	  } & JobWaitProgress)

/**
 * How often the bounds are checked, and how often output is drained.
 *
 * Coarse on purpose, same reasoning as the task version's own interval:
 * both bounds are measured in minutes, so a second of latency noticing
 * either one is irrelevant, and this is an internal timer, not a model
 * turn — it costs nothing external no matter how often it fires.
 */
const POLL_INTERVAL_MS = 1_000

/**
 * Await a job under both bounds, accumulating its output as it goes.
 *
 * Returns the output gathered so far either way: a completed wait has all
 * of it, and a timed-out one has everything read up to the moment it gave
 * up, so the caller never has to throw away a partial answer.
 */
export async function waitForJobWithBounds(
	jobs: Pick<BackgroundJobRegistryRef, 'read' | 'waitForExit'>,
	id: string,
	options: JobWaitOptions,
	now: () => number = Date.now,
): Promise<JobWaitOutcome> {
	if (!jobs.waitForExit) {
		throw new Error('This background job registry cannot wait for a job to exit.')
	}
	const waitForExit = jobs.waitForExit.bind(jobs)

	const startedAt = now()
	let lastProgressAt = startedAt
	let cursor = options.fromOffset ?? 0
	let output = ''
	let droppedBytes = 0
	let settled = false

	/** Read whatever is new since `cursor`, and count it as progress if it is. */
	const drain = (): void => {
		const chunk = jobs.read(id, { fromOffset: cursor })
		if (chunk.droppedBytes > 0) droppedBytes += chunk.droppedBytes
		if (chunk.nextOffset > cursor) lastProgressAt = now()
		cursor = chunk.nextOffset
		if (chunk.chunk) output += chunk.chunk
	}

	try {
		const exited = waitForExit(id, { signal: options.signal }).then((job): JobWaitOutcome => {
			// One last read: the job can exit between ticks, and the bytes
			// it wrote in its final moment are exactly the ones a caller
			// most wants — the error, the summary line, the exit trace.
			drain()
			return {
				kind: 'exited',
				status: job.status,
				...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
				output,
				nextOffset: cursor,
				droppedBytes,
			}
		})

		const expiry = new Promise<JobWaitOutcome>((resolve) => {
			// Polled rather than scheduled, for the same reason the task
			// version is: the idle deadline MOVES on every byte of new
			// output, and a timer armed for it would have to be cleared and
			// rearmed on every tick that mattered.
			const tick = setInterval(() => {
				if (settled) return
				drain()
				const elapsed = now() - startedAt
				if (elapsed >= options.runMs) {
					clearInterval(tick)
					resolve({
						kind: 'timeout',
						cause: 'run',
						elapsedMs: elapsed,
						output,
						nextOffset: cursor,
						droppedBytes,
					})
					return
				}
				if (options.idleMs !== undefined) {
					const quietFor = now() - lastProgressAt
					if (quietFor >= options.idleMs) {
						clearInterval(tick)
						resolve({
							kind: 'timeout',
							cause: 'idle',
							elapsedMs: elapsed,
							output,
							nextOffset: cursor,
							droppedBytes,
						})
					}
				}
			}, POLL_INTERVAL_MS)
			// Never the reason a process stays alive — this races a real
			// exit promise, so the wait is held open by work that is
			// genuinely outstanding rather than by this timer.
			;(tick as { unref?: () => void }).unref?.()
		})

		return await Promise.race([exited, expiry])
	} finally {
		settled = true
	}
}

/** What to tell the model, in the words that fit what actually happened. */
export function describeJobWaitTimeout(
	id: string,
	outcome: Extract<JobWaitOutcome, { kind: 'timeout' }>,
): string {
	const seconds = Math.round(outcome.elapsedMs / 1000)
	const resume = `call wait_for_job again, or job read with from_offset ${outcome.nextOffset}, to see what it does next`
	if (outcome.cause === 'idle') {
		return `Job ${id} went quiet: no new output for a while, after ${seconds}s. It has not been stopped and may still be working — ${resume}.`
	}
	return `Job ${id} has been running for ${seconds}s without finishing. It has not been stopped — ${resume}.`
}
