import type { ForegroundApprover } from '@namzu/computer-use'
import type { BrowserWindowAnswer, BrowserWindowQuestion } from '@namzu/sdk'
import type { QuestionFn } from './agent.js'

/**
 * The one question computer use asks: an application needs the screen for a
 * moment while the person is using it. It goes through the turn's question
 * card, so a run with nobody to answer (exec, scheduled) gets `unavailable`
 * and waits for a still moment instead.
 */
/** The id every screen question carries, so a host can tell it from any other question. */
export const SCREEN_QUESTION_PREFIX = 'screen-'
const NO_APP = 'An application'

const screenQuestionText = (name: string): string => `Let ${name} use the screen for a moment?`

/**
 * The application a screen question is about, or `undefined` when the question is some other one.
 * A host that draws its own card for it (Desktop) reads the name here rather than parsing text.
 */
export function screenQuestionApp(question: {
	readonly questionId: string
	readonly question: string
}): string | undefined {
	if (!question.questionId.startsWith(SCREEN_QUESTION_PREFIX)) return undefined
	const match = /^Let (.+) use the screen for a moment\?$/s.exec(question.question)
	return match?.[1]
}

export function screenApprover(currentAsk: () => QuestionFn | undefined): ForegroundApprover {
	return async (subject, signal) => {
		const ask = currentAsk()
		if (!ask) return 'unavailable'
		const name = subject.app.trim().length > 0 ? subject.app : NO_APP
		const answer = await ask(
			{
				questionId: `${SCREEN_QUESTION_PREFIX}${subject.exe ?? subject.app}`,
				question: screenQuestionText(name),
				header: 'Screen needed',
				options: [
					{
						id: 'allow',
						label: 'Yes, this session',
						description:
							'It cannot be done in the background. Your window and pointer are put back afterwards, and Escape stops it.',
					},
					{ id: 'deny', label: 'Not now' },
				],
				multiSelect: false,
				allowFreeText: false,
			},
			signal,
		)
		if (answer.kind === 'answer')
			return answer.selectedOptionIds.includes('allow') ? 'allow' : 'deny'
		return answer.kind === 'abort' ? 'deny' : 'unavailable'
	}
}

/** The id every browser-window question carries, so a host can tell it from any other question. */
export const BROWSER_WINDOW_QUESTION_PREFIX = 'browser-window-'

const browserWindowQuestionText = (name: string): string =>
	`Let Namzu click and type in ${name} in this conversation?`

/**
 * The browser a browser-window question is about, or `undefined` when the question is some other
 * one. A host that draws its own card for it (Desktop) reads the name here rather than parsing text.
 */
export function browserWindowQuestionApp(question: {
	readonly questionId: string
	readonly question: string
}): string | undefined {
	if (!question.questionId.startsWith(BROWSER_WINDOW_QUESTION_PREFIX)) return undefined
	const match = /^Let Namzu click and type in (.+) in this conversation\?$/s.exec(question.question)
	return match?.[1]
}

/**
 * The question computer use asks before it acts in a person's own browser window: may Namzu click
 * and type there for this conversation. It goes through the turn's question card, so a run with
 * nobody to answer (exec, scheduled) gets `unavailable` and the window stays look-only. Only an
 * answer of `allow` grants; a skipped question, an abort or any other reply does not.
 */
export function browserWindowApprover(
	currentAsk: () => QuestionFn | undefined,
): (question: BrowserWindowQuestion, signal?: AbortSignal) => Promise<BrowserWindowAnswer> {
	return async (subject, signal) => {
		const ask = currentAsk()
		if (!ask) return 'unavailable'
		const answer = await ask(
			{
				questionId: `${BROWSER_WINDOW_QUESTION_PREFIX}${subject.app}`,
				question: browserWindowQuestionText(subject.name),
				header: 'Browser window',
				options: [
					{
						id: 'allow',
						label: 'Allow for this conversation',
						description:
							'Namzu clicks and types in every window of this browser, like in any other app. It is told to ask before it sends, deletes, pays or changes admin settings, and it does not type into a password field.',
					},
					{ id: 'deny', label: 'Not now' },
				],
				multiSelect: false,
				allowFreeText: false,
			},
			signal,
		)
		if (answer.kind === 'answer')
			return answer.selectedOptionIds.includes('allow') ? 'allow' : 'deny'
		return answer.kind === 'abort' ? 'deny' : 'unavailable'
	}
}
