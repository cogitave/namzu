/**
 * What a call is told when the question about it never got an answer, so it
 * was not run.
 *
 * Kept apart from the review that writes them so the executor can tell these
 * refusals from a rule's when it records how a call ended
 * (`ToolMessage.outcome`): a call nobody answered was interrupted, not
 * refused, and may be asked about again.
 */

/** What a call is told when the answer to it could not be taken. */
export const UNANSWERED_CALL =
	'No answer was given for this call, so it was not run. Ask again if it is still needed.'

export const EDIT_NOT_OFFERED =
	'Editing a call while it is asked about is not offered, so this call was not run. Ask again with the input you want.'

export const PAUSED_CALL =
	'The turn was asked to wait before this call could be answered, so it was not run. Ask again if it is still needed.'

export const NOT_THIS_QUESTION =
	'That answer was not an answer to a question about a tool call, so this call was not run.'

/** What a call is told when asking about it failed before any answer came. */
export const APPROVAL_NOT_COMPLETED =
	'The approval for this call could not be completed, so it was not run.'

/** Every text above: a call refused with one of them was never answered. */
export const UNANSWERED_REFUSALS: readonly string[] = [
	UNANSWERED_CALL,
	EDIT_NOT_OFFERED,
	PAUSED_CALL,
	NOT_THIS_QUESTION,
	APPROVAL_NOT_COMPLETED,
]
