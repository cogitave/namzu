import type { ForegroundApprover } from '@namzu/computer-use'
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
	return match?.[1] ?? NO_APP
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
