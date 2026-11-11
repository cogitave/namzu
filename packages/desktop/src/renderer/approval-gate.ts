/**
 * The hold an approval card puts on saying yes, kept free of React so it can be tested with a clock
 * and plain numbers: a short time after a card appears when a click means nothing. Accept used to
 * wait for the end of a long command or diff to be scrolled to as well; it no longer does, and the
 * card states what the request does where it cannot be missed instead.
 */

/** A click that lands this soon after a card appears was aimed at whatever was there before it. */
export const CLICK_GUARD_MS = 400

export interface ClickGuard {
	/** True until the guard time has passed since the card appeared (or was reset). */
	active(): boolean
	/** Starts the guard over, for a card whose request changed. */
	reset(): void
	dispose(): void
}

/**
 * Times the guard from `now`. `onSettled` runs once each time the guard ends, so a view can stop
 * showing it. The timer re-checks the clock, so it never reports an end the clock has not reached.
 */
export function createClickGuard(
	onSettled: () => void,
	options: { ms?: number; now?: () => number } = {},
): ClickGuard {
	const ms = options.ms ?? CLICK_GUARD_MS
	const now = options.now ?? Date.now
	let since = now()
	let timer: ReturnType<typeof setTimeout> | undefined
	let disposed = false
	const active = () => now() - since < ms
	const arm = () => {
		if (timer !== undefined) clearTimeout(timer)
		timer = setTimeout(
			() => {
				timer = undefined
				if (disposed) return
				if (active()) arm()
				else onSettled()
			},
			Math.max(0, ms - (now() - since)),
		)
	}
	arm()
	return {
		active,
		reset() {
			since = now()
			arm()
		},
		dispose() {
			disposed = true
			if (timer !== undefined) clearTimeout(timer)
			timer = undefined
		},
	}
}
