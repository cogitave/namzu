import { describe, expect, it } from 'vitest'
import { DECLINED_TOOL_CALL_FEEDBACK } from '../declined.js'
import {
	REFUSED_WITH_THE_TURN,
	UNANSWERED_CALL,
	isReviewRefusalResult,
} from '../iteration/phases/per-call-review.js'

const denied = (reason: string) => `Error: Tool "bash" was not executed. ${reason}`

describe('isReviewRefusalResult', () => {
	it('recognises the answers to calls the review did not let run', () => {
		for (const reason of [DECLINED_TOOL_CALL_FEEDBACK, REFUSED_WITH_THE_TURN, UNANSWERED_CALL]) {
			expect(isReviewRefusalResult(denied(reason))).toBe(true)
		}
	})

	it('leaves a policy refusal, a failed run and plain text alone', () => {
		expect(isReviewRefusalResult(denied('This command is blocked by a rule.'))).toBe(false)
		expect(isReviewRefusalResult('Error: exit 2')).toBe(false)
		expect(isReviewRefusalResult(UNANSWERED_CALL)).toBe(false)
	})
})
