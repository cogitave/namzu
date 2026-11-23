import {
	AUTO_REVIEW_BLOCKED_PREFIX,
	AUTO_REVIEW_UNAVAILABLE_PREFIX,
	type TurnOutcome,
	isReviewRefusalResult,
} from '@namzu/sdk'

/**
 * Whether a tool result answers a call that never ran because the review did
 * not let it: a person's No, a refusal that stopped the turn, a question left
 * unanswered, or the auto mode's block or missing verdict. A call that ran and
 * failed is not one of these.
 */
export function isCallNotRun(output: string | undefined): boolean {
	if (output === undefined) return false
	if (isReviewRefusalResult(output)) return true
	return (
		output.includes(AUTO_REVIEW_UNAVAILABLE_PREFIX) || output.includes(AUTO_REVIEW_BLOCKED_PREFIX)
	)
}

/**
 * The one plain line a turn ends with when it was stopped because a call was
 * refused or the safety check gave no verdict: what was done and what is left.
 * The model wrote no closing text in that case, so without it the person is
 * left with a bare footer.
 *
 * `changedFiles` is the kernel's own count of what the turn's write tools
 * changed, so it is a floor: a shell command's changes are not in it.
 */
export function stoppedTurnLine(input: {
	readonly outcome: TurnOutcome | undefined
	readonly notRun: number
}): string {
	const changed = input.outcome?.changes.total ?? 0
	const done =
		changed > 0
			? `changed ${changed} ${changed === 1 ? 'file' : 'files'} so far`
			: 'nothing was changed'
	const left =
		input.notRun > 0
			? `${input.notRun} ${input.notRun === 1 ? 'call' : 'calls'} not run`
			: 'the rest of the task is not done'
	return `Stopped before the task was finished · ${done} · ${left} · send a message to carry on`
}
