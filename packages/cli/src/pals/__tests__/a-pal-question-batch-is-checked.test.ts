import type { HITLDecisionRequest, HITLResumeDecision } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { assertPalReviewDecision } from '../review.js'

const item = (id: string, multiSelect: boolean, allowFreeText: boolean) => ({
	id,
	question: `Question ${id}?`,
	options: [
		{ id: 'opt_1', label: 'One' },
		{ id: 'opt_2', label: 'Two' },
	],
	multiSelect,
	allowFreeText,
})

const request = {
	type: 'user_question',
	sessionId: 's',
	turnId: 't',
	checkpointId: 'c',
	question: {
		questionId: 'toolu_1',
		...item('toolu_1#0', false, true),
		questions: [item('toolu_1#0', false, true), item('toolu_1#1', true, false)],
	},
} as unknown as HITLDecisionRequest

const answer = (
	answers: NonNullable<Extract<HITLResumeDecision, { action: 'answer_question' }>['answers']>,
) =>
	({
		action: 'answer_question',
		questionId: 'toolu_1',
		selectedOptionIds: [],
		answers,
	}) as HITLResumeDecision

describe('an answer to a Pal question with several questions', () => {
	it('accepts one entry per question, each within what it offered', () => {
		expect(() =>
			assertPalReviewDecision(
				request,
				answer([
					{ questionId: 'toolu_1#0', selectedOptionIds: ['opt_1'], freeText: 'and more' },
					{ questionId: 'toolu_1#1', selectedOptionIds: ['opt_1', 'opt_2'] },
				]),
			),
		).not.toThrow()
	})

	it('refuses an entry for a question it did not ask, a repeat, two picks on a single choice, an unknown option and text where none is taken', () => {
		for (const answers of [
			[{ questionId: 'other#0', selectedOptionIds: ['opt_1'] }],
			[
				{ questionId: 'toolu_1#0', selectedOptionIds: ['opt_1'] },
				{ questionId: 'toolu_1#0', selectedOptionIds: ['opt_2'] },
			],
			[{ questionId: 'toolu_1#0', selectedOptionIds: ['opt_1', 'opt_2'] }],
			[{ questionId: 'toolu_1#1', selectedOptionIds: ['opt_9'] }],
			[{ questionId: 'toolu_1#1', selectedOptionIds: [], freeText: 'no' }],
		]) {
			expect(
				() => assertPalReviewDecision(request, answer(answers)),
				JSON.stringify(answers),
			).toThrow('Invalid answer to the waiting Pal question.')
		}
	})
})
