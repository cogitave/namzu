import { describe, expect, it } from 'vitest'
import {
	QUESTION_TEXT_MAX,
	readQuestionClosedNotice,
	readQuestionItems,
	readQuestionNotice,
	readQuestionResponse,
} from './question-protocol.js'

const option = { id: 'opt_1', label: 'Board', recommended: true, description: 'High level' }
const single = {
	questionId: 'toolu_1',
	question: 'Who?',
	options: [option, { id: 'opt_2', label: 'Engineers' }],
	multiSelect: false,
	allowFreeText: true,
}

describe('reading a question', () => {
	it('reads a lone question as a list of one, and a batch as it is', () => {
		const lone = readQuestionItems(single)
		expect(lone).toHaveLength(1)
		expect(lone?.[0]).toMatchObject({ id: 'toolu_1', question: 'Who?', multiSelect: false })
		expect(lone?.[0]?.options[0]).toEqual(option)
		const batch = readQuestionItems({
			...single,
			questions: [
				{ ...single, id: 'toolu_1#0' },
				{ ...single, id: 'toolu_1#1', multiSelect: true, allowFreeText: false },
			],
		})
		expect(batch?.map((item) => item.id)).toEqual(['toolu_1#0', 'toolu_1#1'])
		expect(batch?.[1]).toMatchObject({ multiSelect: true, allowFreeText: false })
	})

	it('keeps the recommended mark only where it is exactly true', () => {
		const items = readQuestionItems({
			...single,
			options: [
				{ id: 'opt_1', label: 'A', recommended: 'yes' },
				{ id: 'opt_2', label: 'B' },
			],
		})
		expect(items?.[0]?.options[0]?.recommended).toBeUndefined()
	})

	it('refuses what does not read, rather than drawing part of it', () => {
		expect(readQuestionItems(null)).toBeUndefined()
		expect(readQuestionItems({ ...single, question: '   ' })).toBeUndefined()
		expect(readQuestionItems({ ...single, options: [{ id: 'opt_1' }] })).toBeUndefined()
		expect(readQuestionItems({ ...single, questions: [] })).toBeUndefined()
		expect(readQuestionItems({ ...single, question: 'x'.repeat(2001) })).toBeUndefined()
	})

	it('reads the notice and the closing of one, and nothing without both ids', () => {
		expect(
			readQuestionNotice({ sessionId: 's', requestId: 'r', question: single })?.questions,
		).toHaveLength(1)
		expect(readQuestionNotice({ sessionId: 's', question: single })).toBeUndefined()
		expect(readQuestionClosedNotice({ sessionId: 's', requestId: 'r' })).toEqual({
			sessionId: 's',
			requestId: 'r',
		})
		expect(readQuestionClosedNotice({ sessionId: 's' })).toBeUndefined()
	})
})

describe('reading an answer', () => {
	it('trims the words and drops blank ones', () => {
		expect(
			readQuestionResponse({
				kind: 'answer',
				answers: [
					{ questionId: 'a', selectedOptionIds: ['opt_1'], freeText: '  hi  ' },
					{ questionId: 'b', selectedOptionIds: [], freeText: '   ' },
				],
			}),
		).toEqual({
			kind: 'answer',
			answers: [
				{ questionId: 'a', selectedOptionIds: ['opt_1'], freeText: 'hi' },
				{ questionId: 'b', selectedOptionIds: [] },
			],
		})
		expect(readQuestionResponse({ kind: 'skip' })).toEqual({ kind: 'skip' })
	})

	it('refuses a shape it does not know and words past the limit', () => {
		expect(() => readQuestionResponse({ kind: 'yes' })).toThrow('Invalid answer')
		expect(() => readQuestionResponse({ kind: 'answer', answers: 'x' })).toThrow('Invalid answer')
		expect(() =>
			readQuestionResponse({
				kind: 'answer',
				answers: [{ questionId: 'a', selectedOptionIds: [1] }],
			}),
		).toThrow('Invalid answer')
		expect(() =>
			readQuestionResponse({
				kind: 'answer',
				answers: [
					{ questionId: 'a', selectedOptionIds: [], freeText: 'x'.repeat(QUESTION_TEXT_MAX + 1) },
				],
			}),
		).toThrow('under 4,000')
	})
})
