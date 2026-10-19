import { describe, expect, it } from 'vitest'

import type { UserQuestion } from './agent.js'
import {
	answerLabel,
	buildAnswer,
	dialogQuestions,
	needsQuestionDialog,
	summaryLines,
} from './question-dialog.js'

const opts = (...labels: string[]) => labels.map((label, i) => ({ id: `opt_${i + 1}`, label }))

const single: UserQuestion = {
	questionId: 'toolu_1',
	question: 'Which audience?',
	options: opts('Board', 'Engineers'),
	multiSelect: false,
	allowFreeText: true,
}

const batch: UserQuestion = {
	...single,
	header: 'Audience',
	questions: [
		{ id: 'toolu_1#0', ...single, header: 'Audience' },
		{
			id: 'toolu_1#1',
			question: 'Which environments?',
			header: 'Environment',
			options: opts('Staging', 'Production'),
			multiSelect: true,
			allowFreeText: false,
		},
		{
			id: 'toolu_1#2',
			question: 'What is it for?',
			header: 'Purpose',
			options: opts('Report', 'Audit'),
			multiSelect: false,
			allowFreeText: true,
		},
	],
}

describe('which questions need the card', () => {
	it('leaves a lone single choice to the plain chooser', () => {
		expect(needsQuestionDialog(single)).toBe(false)
	})
	it('takes a batch and a multi-select', () => {
		expect(needsQuestionDialog(batch)).toBe(true)
		expect(needsQuestionDialog({ ...single, multiSelect: true })).toBe(true)
	})
	it('reads a lone question as a batch of one', () => {
		expect(dialogQuestions(single)).toHaveLength(1)
		expect(dialogQuestions(single)[0]?.id).toBe('toolu_1')
		expect(dialogQuestions(batch)).toHaveLength(3)
	})
})

describe('the answer the model is given', () => {
	it('carries one entry per answered question, with the other-text as free text', () => {
		const picks = {
			picked: [['opt_2'], ['opt_1', 'opt_2'], []],
			text: ['', '', '  monthly cost report '],
		}
		expect(buildAnswer(batch, picks)).toEqual({
			kind: 'answer',
			selectedOptionIds: [],
			answers: [
				{ questionId: 'toolu_1#0', selectedOptionIds: ['opt_2'] },
				{ questionId: 'toolu_1#1', selectedOptionIds: ['opt_1', 'opt_2'] },
				{ questionId: 'toolu_1#2', selectedOptionIds: [], freeText: 'monthly cost report' },
			],
		})
	})

	it('leaves out a question that was not answered', () => {
		const answer = buildAnswer(batch, { picked: [[], ['opt_1'], []], text: ['', '', ''] })
		expect(answer).toMatchObject({
			kind: 'answer',
			answers: [{ questionId: 'toolu_1#1', selectedOptionIds: ['opt_1'] }],
		})
	})

	it('is a skip, never an empty answer, when nothing was answered', () => {
		expect(buildAnswer(batch, { picked: [[], [], []], text: ['', ' ', ''] })).toEqual({
			kind: 'skip',
		})
	})

	it('keeps the single-question shape for a lone multi-select', () => {
		const lone = { ...single, multiSelect: true }
		expect(buildAnswer(lone, { picked: [['opt_1', 'opt_2']], text: ['then both'] })).toEqual({
			kind: 'answer',
			selectedOptionIds: ['opt_1', 'opt_2'],
			freeText: 'then both',
		})
	})

	it('writes one transcript line per answered question', () => {
		const picks = { picked: [['opt_1'], ['opt_1', 'opt_2'], []], text: ['', '', 'ops'] }
		expect(summaryLines(batch, picks)).toEqual([
			'Answered "Which audience?": Board',
			'Answered "Which environments?": Staging, Production',
			'Answered "What is it for?": ops',
		])
		const [first] = dialogQuestions(batch)
		expect(answerLabel(first as never, picks, 0)).toBe('Board')
	})
})
