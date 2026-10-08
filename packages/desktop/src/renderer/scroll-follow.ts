// Small pieces of the transcript's follow logic that are decided without a DOM, so they can be
// tested without a clock race. markAuto follows OpenCode's session scroll handling and the
// disclosure pause follows assistant-ui's thread viewport auto-scroll (both MIT).

/** How close to the end counts as being at the end. */
export const latestThreshold = 48

/** A disclosure's panel animates for 200 ms (ui/collapsible.tsx); this leaves a frame of slack. */
export const disclosureSettleMs = 260

export interface AutoScrollMark {
	/** Record that the code is about to set the scroll position to `top`. */
	mark(top: number): void
	/** Whether a scroll event at `top` is the echo of a recorded programmatic scroll. Consumes the mark. */
	consume(top: number): boolean
}

/**
 * A scroll event does not say who caused it. The code marks the position it sets; the event that
 * arrives at that position within `ttl` is its own echo, not the reader leaving the end. Without
 * this, a reply that grows between the set and the event reads as the reader scrolling up.
 */
export function createAutoScrollMark(ttl = 250, now: () => number = Date.now): AutoScrollMark {
	let pending: { top: number; at: number } | undefined
	return {
		mark(top) {
			pending = { top, at: now() }
		},
		consume(top) {
			const mark = pending
			if (!mark) return false
			if (now() - mark.at > ttl) {
				pending = undefined
				return false
			}
			if (Math.abs(top - mark.top) > 2) return false
			pending = undefined
			return true
		},
	}
}

/** A panel taller than a third of the view is being read, so following pauses while it is open. */
export function panelPausesFollow(
	panelHeight: number | undefined,
	viewportHeight: number,
): boolean {
	return panelHeight !== undefined && panelHeight > viewportHeight / 3
}

/**
 * After a disclosure the reader opened has finished growing: whether to follow again. A reader who
 * was following and has not scrolled keeps following when the panel is a small one, because the
 * distance from the end then comes from the reply still streaming, not from the panel (a fast
 * stream outgrows `latestThreshold` in the 260 ms the panel takes). A tall panel is being read, so
 * following resumes only if the reader is back at the end.
 */
export function followAfterDisclosure(
	distanceFromEnd: number,
	options: {
		wasFollowing?: boolean
		moved?: boolean
		panelHeight?: number
		viewportHeight?: number
	} = {},
): boolean {
	if (distanceFromEnd <= latestThreshold) return true
	const {
		wasFollowing = false,
		moved = false,
		panelHeight = Number.POSITIVE_INFINITY,
		viewportHeight = 0,
	} = options
	return wasFollowing && !moved && !panelPausesFollow(panelHeight, viewportHeight)
}
