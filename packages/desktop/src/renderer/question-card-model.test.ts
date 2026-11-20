import { describe, expect, it } from 'vitest'
import type { QuestionItem } from '../shared/question-protocol.js'
import {
	answeredCount,
	buildQuestionResponse,
	confirms,
	emptyQuestionDraft,
	isAnswered,
	pickOption,
	questionLabel,
	rowForDigit,
	toggleOther,
	writeOther,
} from './question-card-model.js'

const single: QuestionItem = {
	id: 'q1',
	question: 'Who is the audience?',
	header: 'Audience',
	multiSelect: false,
	allowFreeText: true,
	options: [
		{ id: 'opt_1', label: 'Board', recommended: true },
		{ id: 'opt_2', label: 'Engineers' },
	],
}
const multi: QuestionItem = {
	id: 'q2',
	question: 'Which environments?',
	multiSelect: true,
	allowFreeText: true,
	options: [
		{ id: 'opt_1', label: 'Staging' },
		{ id: 'opt_2', label: 'Production' },
		{ id: 'opt_3', label: 'Local' },
	],
}
const closed: QuestionItem = { ...single, id: 'q3', allowFreeText: false }

describe('choosing', () => {
	it('holds one option on a single choice, and a second press keeps it', () => {
		let draft = pickOption(emptyQuestionDraft, single, 'opt_1')
		draft = pickOption(draft, single, 'opt_2')
		expect(draft.picked.q1).toEqual(['opt_2'])
		expect(pickOption(draft, single, 'opt_2').picked.q1).toEqual(['opt_2'])
	})

	it('toggles options on a multiple choice, in the order they were picked', () => {
		let draft = pickOption(emptyQuestionDraft, multi, 'opt_3')
		draft = pickOption(draft, multi, 'opt_1')
		expect(draft.picked.q2).toEqual(['opt_3', 'opt_1'])
		draft = pickOption(draft, multi, 'opt_3')
		expect(draft.picked.q2).toEqual(['opt_1'])
	})

	it('ignores an option the question does not have', () => {
		expect(pickOption(emptyQuestionDraft, single, 'opt_9')).toBe(emptyQuestionDraft)
	})
})

describe('the person’s own words (Other)', () => {
	it('replaces the pick on a single choice, and a pick closes it again', () => {
		let draft = pickOption(emptyQuestionDraft, single, 'opt_1')
		draft = toggleOther(draft, single)
		expect(draft.picked.q1).toEqual([])
		draft = writeOther(draft, single, 'the sales team')
		expect(isAnswered(draft, single)).toBe(true)
		draft = pickOption(draft, single, 'opt_2')
		expect(draft.other.q1?.open).toBe(false)
		// Words that are no longer shown are not sent.
		expect(buildQuestionResponse(draft, [single])).toEqual({
			kind: 'answer',
			answers: [{ questionId: 'q1', selectedOptionIds: ['opt_2'] }],
		})
	})

	it('sits beside the picks on a multiple choice', () => {
		let draft = pickOption(emptyQuestionDraft, multi, 'opt_2')
		draft = toggleOther(draft, multi)
		draft = writeOther(draft, multi, '  a preview site ')
		expect(buildQuestionResponse(draft, [multi])).toEqual({
			kind: 'answer',
			answers: [{ questionId: 'q2', selectedOptionIds: ['opt_2'], freeText: 'a preview site' }],
		})
	})

	it('is not an answer while it is blank, and does not exist where the question forbids it', () => {
		let draft = toggleOther(emptyQuestionDraft, single)
		draft = writeOther(draft, single, '   ')
		expect(isAnswered(draft, single)).toBe(false)
		expect(toggleOther(emptyQuestionDraft, closed)).toBe(emptyQuestionDraft)
		expect(writeOther(emptyQuestionDraft, closed, 'x')).toBe(emptyQuestionDraft)
	})
})

describe('what goes back', () => {
	it('names one entry per question answered, in the order asked, and leaves the others out', () => {
		let draft = pickOption(emptyQuestionDraft, multi, 'opt_1')
		draft = pickOption(draft, single, 'opt_1')
		expect(answeredCount(draft, [single, multi, closed])).toBe(2)
		expect(buildQuestionResponse(draft, [single, multi, closed])).toEqual({
			kind: 'answer',
			answers: [
				{ questionId: 'q1', selectedOptionIds: ['opt_1'] },
				{ questionId: 'q2', selectedOptionIds: ['opt_1'] },
			],
		})
	})

	it('is a skip, never an empty answer, when nothing was answered', () => {
		expect(buildQuestionResponse(emptyQuestionDraft, [single, multi])).toEqual({ kind: 'skip' })
	})
})

describe('the keys', () => {
	it('takes Enter from the main keys and from the number pad', () => {
		expect(confirms({ key: 'Enter', code: 'Enter' })).toBe(true)
		expect(confirms({ key: 'Enter', code: 'NumpadEnter' })).toBe(true)
		// A layout that reports only the physical key still confirms.
		expect(confirms({ key: 'Unidentified', code: 'NumpadEnter' })).toBe(true)
		expect(confirms({ key: 'a', code: 'KeyA' })).toBe(false)
	})

	it('names the row a digit picks, and no row past the last', () => {
		expect(rowForDigit('1', 3)).toBe(0)
		expect(rowForDigit('3', 3)).toBe(2)
		expect(rowForDigit('4', 3)).toBeUndefined()
		expect(rowForDigit('0', 3)).toBeUndefined()
		expect(rowForDigit('a', 3)).toBeUndefined()
	})

	it('labels a question by its header, else by its place', () => {
		expect(questionLabel(single, 0, 2)).toBe('Audience')
		expect(questionLabel(multi, 1, 2)).toBe('Question 2')
		expect(questionLabel(multi, 0, 1)).toBe('Question')
	})
})
