import type { InterruptionKind } from './plain-interruption.js'

/**
 * How a paused reply comes back on its own.
 *
 * A reply pauses once the kernel has spent its retries on a connection that
 * would not hold. That is rarely the end of the trouble: a network comes back,
 * a provider recovers. The pause therefore keeps trying on a schedule, and the
 * person can press Enter to try at once or Esc to stop at any time.
 */

/** Waits between tries, in order; the last one repeats until the person stops it. */
export const AUTO_RESUME_DELAYS_MS: readonly number[] = [15_000, 30_000, 60_000, 120_000, 300_000]

/** The wait before try number `attempt` (1 is the first), never shorter than the first step. */
export function autoResumeDelayMs(attempt: number): number {
	const last = AUTO_RESUME_DELAYS_MS.length - 1
	const index = Math.min(Math.max(Math.trunc(attempt), 1) - 1, last)
	return AUTO_RESUME_DELAYS_MS[index] ?? 300_000
}

/**
 * Pauses that pass by themselves: the provider could not be reached, or had
 * trouble on its side. A rejected key, a refused request or a full context
 * window do not, and wait for the person.
 */
export function isAutoResumable(kind: InterruptionKind): boolean {
	return kind === 'network' || kind === 'server'
}

export interface AutoResumeTimers {
	readonly setTimer: (run: () => void, ms: number) => unknown
	readonly clearTimer: (handle: unknown) => void
}

export interface AutoResumeOptions {
	/** Milliseconds until the first try. */
	readonly delayMs: number
	/** Whether the screen can take the continued reply now (idle, nothing else running). */
	readonly ready: () => boolean
	/** Continue the paused reply. */
	readonly resume: () => void
	/** How long to wait before asking `ready` again when the screen was busy. */
	readonly recheckMs?: number
	readonly timers?: AutoResumeTimers
}

const REAL_TIMERS: AutoResumeTimers = {
	setTimer: (run, ms) => setTimeout(run, ms),
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Continue a paused reply after `delayMs`, waiting further while the screen is
 * busy. Returns the function that cancels it.
 */
export function startAutoResume(options: AutoResumeOptions): () => void {
	const timers = options.timers ?? REAL_TIMERS
	const recheckMs = options.recheckMs ?? 1_000
	let cancelled = false
	let handle: unknown
	const attempt = () => {
		if (cancelled) return
		if (!options.ready()) {
			handle = timers.setTimer(attempt, recheckMs)
			return
		}
		options.resume()
	}
	handle = timers.setTimer(attempt, Math.max(0, options.delayMs))
	return () => {
		cancelled = true
		timers.clearTimer(handle)
	}
}
