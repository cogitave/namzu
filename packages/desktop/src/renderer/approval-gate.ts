/**
 * The two holds an approval card puts on saying yes, kept free of React so each can be tested with
 * a clock and plain numbers: a short time after a card appears when a click means nothing, and the
 * end of a long command or diff that has to be on screen before it can be allowed.
 */

/** A click that lands this soon after a card appears was aimed at whatever was there before it. */
export const CLICK_GUARD_MS = 400
/** How far from the end of a scrolled box still counts as having reached it (fractional scroll offsets). */
export const READ_END_SLACK_PX = 2

export interface ScrollMeasure {
	scrollHeight: number
	clientHeight: number
	scrollTop: number
}

/**
 * True while a box has more to show than fits and its end has not been reached. A box that fits is
 * never held, so a short command cannot trap anyone.
 */
export function unreadContent(measure: ScrollMeasure): boolean {
	const overflow = measure.scrollHeight - measure.clientHeight
	if (overflow <= READ_END_SLACK_PX) return false
	return overflow - measure.scrollTop > READ_END_SLACK_PX
}

/** The line that explains a held Allow, worded for what is hidden. */
export function readGateHint(unread: {
	command?: boolean
	message?: boolean
	diff?: boolean
}): string | undefined {
	if (unread.command) return 'Scroll through the whole command to allow it.'
	if (unread.message) return 'Scroll through the whole message to allow it.'
	if (unread.diff) return 'Scroll to the end to allow this.'
	return undefined
}

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
