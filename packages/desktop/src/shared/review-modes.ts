import type { ReviewMode } from '@namzu/sdk'

/**
 * The review modes the window sends and stores.
 *
 * `bypass` is Full access and `classify` is Auto. The kernel's own `auto`
 * (nobody is asked, so anything out of bounds is refused) is what Full access
 * used to be called; it is still read from older saved settings and from a
 * caller that sends it, and means Full access from here on.
 */
export const REVIEW_MODE_IDS = [
	'prompt',
	'accept-edits',
	'plan',
	'bypass',
	'classify',
	'strict',
	'auto',
] as const satisfies readonly ReviewMode[]

export function isReviewModeId(value: unknown): value is ReviewMode {
	return typeof value === 'string' && (REVIEW_MODE_IDS as readonly string[]).includes(value)
}

/** The mode a stored or received id means today: the old Full access id is `bypass`. */
export function currentReviewMode(mode: ReviewMode): ReviewMode {
	return mode === 'auto' ? 'bypass' : mode
}
