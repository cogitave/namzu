import type { ForegroundApprover } from '@namzu/computer-use'
import type { QuestionFn } from './agent.js'

/**
 * The one question computer use asks: an application needs the screen for a
 * moment while the person is using it. It goes through the turn's question
 * card, so a run with nobody to answer (exec, scheduled) gets `unavailable`
 * and waits for a still moment instead.
 */
export function screenApprover(currentAsk: () => QuestionFn | undefined): ForegroundApprover {
	return async (subject, signal) => {
		const ask = currentAsk()
		if (!ask) return 'unavailable'
		const name = subject.app.trim().length > 0 ? subject.app : 'An application'
		const answer = await ask(
			{
				questionId: `screen-${subject.exe ?? subject.app}`,
				question: `Let ${name} use the screen for a moment?`,
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
