/**
 * How many times the queued-messages hint is offered, across launches, before
 * the plain placeholder takes over. The hint shows while the stored count is
 * below three.
 */
export const QUEUED_HINT_LIMIT = 3

export const QUEUED_HINT = 'Press up to edit queued messages'

/** The persisted number of times the queued hint has appeared. */
export interface QueuedHintCount {
	readonly read: () => number
	readonly write: (count: number) => void
}

/** What the hint does for an appearance that starts now. */
export interface QueuedHintEpisode {
	readonly active: boolean
	readonly show: boolean
	/** Appearances so far, this one included when it shows. */
	readonly count: number
}

/**
 * Decide, before the frame is drawn, whether a placeholder that is about to
 * appear shows the hint. One appearance counts once: the episode ends when the
 * placeholder goes away (a draft, a hidden composer, no queue).
 */
export function nextQueuedHintEpisode(
	previous: QueuedHintEpisode,
	wanted: boolean,
): QueuedHintEpisode {
	if (wanted === previous.active) return previous
	if (!wanted) return { active: false, show: false, count: previous.count }
	const show = previous.count < QUEUED_HINT_LIMIT
	return { active: true, show, count: show ? previous.count + 1 : previous.count }
}
