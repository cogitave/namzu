/**
 * What a question card with several questions (or a multi-select one) holds,
 * and how it becomes the answer the model reads.
 *
 * Kept apart from the screen so the mapping from what the operator did to
 * what `ask_user_question` receives is tested without a terminal. A lone
 * single-choice question never comes here: it stays the plain chooser.
 */

import type { QuestionAnswer, UserQuestion } from './agent.js'
import { choiceDisplayText } from './terminal-choice-text.js'

/** One question of the card, whether the call carried one or several. */
export type DialogQuestion = NonNullable<UserQuestion['questions']>[number]

/** What the operator has picked so far, per question, in the order asked. */
export interface QuestionPicks {
	/** Option ids chosen, per question. */
	readonly picked: readonly (readonly string[])[]
	/** The "Something else…" text, per question; empty when none. */
	readonly text: readonly string[]
}

export function dialogQuestions(question: UserQuestion): readonly DialogQuestion[] {
	return (
		question.questions ?? [
			{
				id: question.questionId,
				question: question.question,
				...(question.header !== undefined ? { header: question.header } : {}),
				options: question.options,
				multiSelect: question.multiSelect,
				allowFreeText: question.allowFreeText,
			},
		]
	)
}

/** A single choice keeps the plain chooser; anything else needs the card. */
export function needsQuestionDialog(question: UserQuestion): boolean {
	return question.questions !== undefined || question.multiSelect
}

export function isAnswered(picks: QuestionPicks, index: number): boolean {
	return (picks.picked[index]?.length ?? 0) > 0 || (picks.text[index]?.trim() ?? '') !== ''
}

/**
 * The operator's answers as the tool takes them. A lone question keeps the
 * single-question shape, so nothing between here and the tool changes for it;
 * a batch carries one entry per question that was answered. Nothing answered
 * is a skip, never an empty answer.
 */
export function buildAnswer(question: UserQuestion, picks: QuestionPicks): QuestionAnswer {
	const items = dialogQuestions(question)
	if (!items.some((_, index) => isAnswered(picks, index))) return { kind: 'skip' }
	const entry = (index: number) => {
		const text = picks.text[index]?.trim() ?? ''
		return {
			selectedOptionIds: [...(picks.picked[index] ?? [])],
			...(text !== '' ? { freeText: text } : {}),
		}
	}
	if (question.questions === undefined) return { kind: 'answer', ...entry(0) }
	return {
		kind: 'answer',
		selectedOptionIds: [],
		answers: items.flatMap((item, index) =>
			isAnswered(picks, index) ? [{ questionId: item.id, ...entry(index) }] : [],
		),
	}
}

/** What a question's answer reads like on the card and in the transcript. */
export function answerLabel(item: DialogQuestion, picks: QuestionPicks, index: number): string {
	const labels = (picks.picked[index] ?? []).flatMap((id) => {
		const option = item.options.find((candidate) => candidate.id === id)
		return option ? [option.label] : []
	})
	const text = picks.text[index]?.trim() ?? ''
	return [...labels, ...(text !== '' ? [text] : [])].map(choiceDisplayText).join(', ')
}

/** One transcript line per answered question, so the reader sees the choice where it happened. */
export function summaryLines(question: UserQuestion, picks: QuestionPicks): string[] {
	return dialogQuestions(question).flatMap((item, index) =>
		isAnswered(picks, index)
			? [`Answered "${item.question}": ${answerLabel(item, picks, index)}`]
			: [],
	)
}
