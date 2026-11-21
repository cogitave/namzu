/**
 * What the model is told when the auto mode keeps a call from running.
 *
 * Two kinds, worded apart on purpose. A block is the classifier's judgement
 * that the call is unsafe, and the model is told not to route around it. A
 * call held back because the check gave no verdict says nothing about the call
 * itself, and the model may try it again. The executor tells the two apart by
 * these prefixes when it records how a refused call ended
 * (`ToolMessage.outcome`); the text is the policy's own, never a tool's.
 */

/** How every refusal by the classifier's verdict begins. */
export const AUTO_REVIEW_BLOCKED_PREFIX = 'Blocked by auto mode: '

/** How every refusal for want of a verdict begins. */
export const AUTO_REVIEW_UNAVAILABLE_PREFIX = 'Auto mode could not check this action: '

/** The words the model is told when a call is blocked. */
export function autoReviewBlockedFeedback(reason: string): string {
	return `${AUTO_REVIEW_BLOCKED_PREFIX}${reason}. Do not try to work around this; if the action is needed, tell the user what you want to do and why, so they can approve it or switch modes.`
}

/**
 * The words the model is told when a call was held back because the check
 * could not be completed or its answer could not be read.
 */
export function autoReviewUnavailableFeedback(reason: string): string {
	return `${AUTO_REVIEW_UNAVAILABLE_PREFIX}${reason}. Nothing was run. This is not a judgement on the action: if it is still needed, it may be tried again, and if the check keeps failing, tell the user.`
}
