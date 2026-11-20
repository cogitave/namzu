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

export interface ReaderInput {
	/** A wheel, touch or key was used on the transcript just now. */
	touch(coastMs?: number): void
	/** A pointer went down on the transcript's scrollbar and has not come up yet. */
	hold(): void
	release(): void
	/** Whether the reader is, or was a moment ago, the one moving the scroller. */
	recent(): boolean
}

/**
 * The browser moves the scroller itself when the page re-lays-out above the view (scroll anchoring),
 * and that scroll event looks the same as the reader's. What tells them apart is input: a scroll the
 * reader made comes with a wheel, touch or key on the transcript, or a pointer on its scrollbar (a dragged
 * scrollbar keeps the pointer down) within `ttl`.
 */
export function createReaderInput(ttl = 300, now: () => number = Date.now): ReaderInput {
	let last = Number.NEGATIVE_INFINITY
	let held = false
	return {
		// `coastMs` extends the window past the call: a finger lifted from a fling keeps scrolling.
		touch(coastMs = 0) {
			last = now() + coastMs
		},
		hold() {
			held = true
			last = now()
		},
		release() {
			held = false
			last = now()
		},
		recent() {
			return held || now() - last <= ttl
		},
	}
}

/**
 * What a scroll event that the code did not make means for following. Only the reader scrolling up
 * leaves the end; a browser-made shift keeps following (and the view is pinned again), and one that
 * lands at the end follows. `following` is whether the transcript was following before the event.
 */
export function readScroll(options: {
	following: boolean
	atLatest: boolean
	movedUp: boolean
	fromReader: boolean
}): { follow: boolean; repin: boolean } {
	const { following, atLatest, movedUp, fromReader } = options
	if (atLatest) return { follow: true, repin: false }
	if (fromReader) return { follow: movedUp ? false : following, repin: false }
	return { follow: following, repin: following }
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
