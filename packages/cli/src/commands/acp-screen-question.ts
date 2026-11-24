import type { QuestionAnswer, QuestionFn } from '../tui/agent.js'
import { browserWindowQuestionApp, screenQuestionApp } from '../tui/computer-use-screen-approval.js'

/**
 * The name of the request Desktop draws as the "screen needed for a moment" card. It travels
 * through the permission request `namzu acp` already sends its client, as a call the agent marks
 * `alwaysAsk`, so a standing "allow for this conversation" never answers it.
 */
export const SCREEN_MOMENT_TOOL = 'screen_moment'
/**
 * The request Desktop draws as the "click and type in this browser for this conversation" card. It
 * travels the same way: an `alwaysAsk` call, so no remembered yes and no permission mode answers it.
 */
export const BROWSER_WINDOW_TOOL = 'browser_window'

type PermissionAsk = (request: {
	sessionId: string
	toolCalls: readonly {
		id: string
		name: string
		input: unknown
		isDestructive: boolean
		alwaysAsk?: true
	}[]
}) => Promise<{ kind: 'approve' } | { kind: 'approve_all' } | { kind: 'reject' }>

/**
 * A question channel for an ACP conversation. Only the screen and browser-window questions have a card, so any other
 * question is skipped (the tool then tells the model nobody answered), exactly as before. A yes is
 * only ever the person's answer: a request nobody can answer, or that fails, is `skip`, which the
 * ladder reads as "wait for a still moment", and the turn stopping is `abort`.
 */
export function questionsOverPermission(
	sessionId: string,
	ask: PermissionAsk,
	turnSignal: AbortSignal,
): QuestionFn {
	let counter = 0
	return async (question, signal): Promise<QuestionAnswer> => {
		const screen = screenQuestionApp(question)
		const browser = screen === undefined ? browserWindowQuestionApp(question) : undefined
		const app = screen ?? browser
		if (app === undefined) return { kind: 'skip' }
		if (turnSignal.aborted) return { kind: 'abort' }
		counter += 1
		const asked = ask({
			sessionId,
			toolCalls: [
				{
					id: `${browser === undefined ? 'screen-moment' : 'browser-window'}-${counter}`,
					name: browser === undefined ? SCREEN_MOMENT_TOOL : BROWSER_WINDOW_TOOL,
					input: { app },
					isDestructive: false,
					alwaysAsk: true,
				},
			],
		}).then(
			(outcome): QuestionAnswer =>
				outcome.kind === 'reject'
					? { kind: 'answer', selectedOptionIds: ['deny'] }
					: { kind: 'answer', selectedOptionIds: ['allow'] },
			(): QuestionAnswer => (turnSignal.aborted ? { kind: 'abort' } : { kind: 'skip' }),
		)
		if (!signal) return asked
		// The caller stopped waiting: its answer would arrive for nothing, so do not wait for it.
		const stopped = new Promise<QuestionAnswer>((resolve) => {
			const done = () => resolve({ kind: 'skip' })
			if (signal.aborted) done()
			else signal.addEventListener('abort', done, { once: true })
		})
		return Promise.race([asked, stopped])
	}
}
