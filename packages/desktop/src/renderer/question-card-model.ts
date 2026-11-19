import {
	QUESTION_TEXT_MAX,
	type QuestionItem,
	type QuestionResponse,
} from '../shared/question-protocol.js'

/**
 * What a question card holds while the person answers: the options picked and the words written
 * in "Other", per question. No React and no clock, so the rules can be tested on their own.
 */
export interface QuestionDraft {
	picked: Readonly<Record<string, readonly string[]>>
	other: Readonly<Record<string, { open: boolean; text: string }>>
}

export const emptyQuestionDraft: QuestionDraft = { picked: {}, other: {} }

const picked = (draft: QuestionDraft, item: QuestionItem): readonly string[] =>
	draft.picked[item.id] ?? []

export const otherOf = (draft: QuestionDraft, item: QuestionItem) =>
	draft.other[item.id] ?? { open: false, text: '' }

/**
 * Picking an option. A single-choice question holds one, and picking it closes "Other"; a
 * multiple-choice question toggles it. Picking the one already held on a single-choice question
 * keeps it (a second press never takes an answer back by accident).
 */
export function pickOption(
	draft: QuestionDraft,
	item: QuestionItem,
	optionId: string,
): QuestionDraft {
	if (!item.options.some((option) => option.id === optionId)) return draft
	const held = picked(draft, item)
	if (item.multiSelect) {
		const next = held.includes(optionId)
			? held.filter((id) => id !== optionId)
			: [...held, optionId]
		return { ...draft, picked: { ...draft.picked, [item.id]: next } }
	}
	return {
		picked: { ...draft.picked, [item.id]: [optionId] },
		other: { ...draft.other, [item.id]: { open: false, text: otherOf(draft, item).text } },
	}
}

/**
 * Opening or closing "Other" (the person's own words). On a single-choice question it replaces
 * the pick; on a multiple-choice question it sits beside the others.
 */
export function toggleOther(draft: QuestionDraft, item: QuestionItem): QuestionDraft {
	if (!item.allowFreeText) return draft
	const current = otherOf(draft, item)
	const open = !current.open
	return {
		picked: open && !item.multiSelect ? { ...draft.picked, [item.id]: [] } : draft.picked,
		other: { ...draft.other, [item.id]: { open, text: current.text } },
	}
}

export function writeOther(draft: QuestionDraft, item: QuestionItem, text: string): QuestionDraft {
	if (!item.allowFreeText) return draft
	return {
		...draft,
		other: { ...draft.other, [item.id]: { open: true, text: text.slice(0, QUESTION_TEXT_MAX) } },
	}
}

/** The words written for a question, when "Other" is open and they are not blank. */
export function otherText(draft: QuestionDraft, item: QuestionItem): string | undefined {
	const other = otherOf(draft, item)
	if (!item.allowFreeText || !other.open) return undefined
	const trimmed = other.text.trim()
	return trimmed ? trimmed : undefined
}

export const isAnswered = (draft: QuestionDraft, item: QuestionItem): boolean =>
	picked(draft, item).length > 0 || otherText(draft, item) !== undefined

export const answeredCount = (draft: QuestionDraft, items: readonly QuestionItem[]): number =>
	items.filter((item) => isAnswered(draft, item)).length

/**
 * What goes back to the agent: one entry per question that holds an answer, in the order asked.
 * Nothing answered is `skip`, never an empty answer.
 */
export function buildQuestionResponse(
	draft: QuestionDraft,
	items: readonly QuestionItem[],
): QuestionResponse {
	const answers = items
		.filter((item) => isAnswered(draft, item))
		.map((item) => {
			const text = otherText(draft, item)
			return {
				questionId: item.id,
				selectedOptionIds: item.options
					.filter((option) => picked(draft, item).includes(option.id))
					.map((option) => option.id),
				...(text ? { freeText: text } : {}),
			}
		})
	return answers.length > 0 ? { kind: 'answer', answers } : { kind: 'skip' }
}

/** A key that confirms: Enter on the main keys and on the number pad both say `Enter`. */
export const confirms = (event: { key: string; code?: string }): boolean =>
	event.key === 'Enter' || event.code === 'NumpadEnter'

/** The row a digit key names (1 is the first row), or `undefined` for any other key. */
export function rowForDigit(key: string, rows: number): number | undefined {
	if (!/^[1-9]$/.test(key)) return undefined
	const row = Number(key) - 1
	return row < rows ? row : undefined
}

/** Where the question row of a header goes: its header chip, else a plain "Question". */
export const questionLabel = (item: QuestionItem, index: number, total: number): string =>
	item.header ?? (total > 1 ? `Question ${index + 1}` : 'Question')
