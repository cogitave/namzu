/**
 * The clock and timer the network code runs on. Every timer, deadline, bucket
 * and expiry in this module reads these two functions so that a test (or a host
 * with its own scheduler) can drive time deterministically instead of waiting.
 *
 * @experimental
 */

export interface NetworkClock {
	now(): number
	/** Run `fn` once after `ms`; returns a function that cancels it. */
	setTimer(fn: () => void, ms: number): () => void
}

export const systemClock: NetworkClock = {
	now: () => Date.now(),
	setTimer(fn, ms) {
		const handle = setTimeout(fn, ms)
		handle.unref?.()
		return () => clearTimeout(handle)
	},
}

export interface ManualClock extends NetworkClock {
	/** Move time forward and run every timer that became due, in order. */
	advance(ms: number): void
	readonly pending: number
}

/** A clock that moves only when told to. For tests and for hosts that schedule themselves. */
export function createManualClock(start = 1_700_000_000_000): ManualClock {
	let current = start
	let nextId = 0
	const timers = new Map<number, { at: number; fn: () => void }>()
	return {
		now: () => current,
		setTimer(fn, ms) {
			const id = nextId++
			timers.set(id, { at: current + ms, fn })
			return () => {
				timers.delete(id)
			}
		},
		advance(ms) {
			const target = current + ms
			for (;;) {
				let due: [number, { at: number; fn: () => void }] | undefined
				for (const entry of timers) {
					if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry
				}
				if (!due) break
				timers.delete(due[0])
				current = Math.max(current, due[1].at)
				due[1].fn()
			}
			current = target
		},
		get pending() {
			return timers.size
		},
	}
}
