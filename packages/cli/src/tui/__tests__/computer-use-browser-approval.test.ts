import { describe, expect, it, vi } from 'vitest'
import { BROWSER_WINDOW_TOOL, questionsOverPermission } from '../../commands/acp-screen-question.js'
import type { QuestionFn } from '../agent.js'
import {
	browserWindowApprover,
	browserWindowQuestionApp,
	screenQuestionApp,
} from '../computer-use-screen-approval.js'

/**
 * The question computer use asks before it clicks and types in a person's own browser window:
 * only an answer grants it, nothing else does, and a host that cannot ask never gets a yes.
 */

const subject = { app: 'brave-browser', name: 'Brave' }
const never = new AbortController().signal

describe('the browser window question', () => {
	it('offers allow for this conversation or not now, in plain words', async () => {
		const ask = vi.fn<QuestionFn>(async () => ({ kind: 'skip' }))
		await browserWindowApprover(() => ask)(subject)
		const question = ask.mock.calls[0]?.[0]
		expect(question?.question).toBe('Let Namzu click and type in Brave in this conversation?')
		expect(question?.options?.map((option) => option.label)).toEqual([
			'Allow for this conversation',
			'Not now',
		])
		expect(question?.allowFreeText).toBe(false)
		expect(browserWindowQuestionApp(question as never)).toBe('Brave')
		expect(screenQuestionApp(question as never)).toBeUndefined()
	})

	it('reads the browser from the question whatever the product is called', () => {
		const question = {
			questionId: 'browser-window-brave-browser',
			question: 'Let Acme Pilot click and type in Brave in this conversation?',
		}
		expect(browserWindowQuestionApp(question)).toBe('Brave')
	})

	it('reads the person’s pick, and nothing else, as a yes', async () => {
		const answer = (value: Awaited<ReturnType<QuestionFn>>) => async () => value
		const run = (value: Awaited<ReturnType<QuestionFn>>) =>
			browserWindowApprover(() => answer(value))(subject)
		await expect(run({ kind: 'answer', selectedOptionIds: ['allow'] })).resolves.toBe('allow')
		await expect(run({ kind: 'answer', selectedOptionIds: ['deny'] })).resolves.toBe('deny')
		await expect(run({ kind: 'answer', selectedOptionIds: [] })).resolves.toBe('deny')
		await expect(run({ kind: 'abort' })).resolves.toBe('deny')
		await expect(run({ kind: 'skip' })).resolves.toBe('unavailable')
	})

	it('has nobody to ask in a run without a question channel (exec, scheduled)', async () => {
		await expect(browserWindowApprover(() => undefined)(subject)).resolves.toBe('unavailable')
	})

	it('reaches Desktop as one always-ask call no standing yes can answer', async () => {
		const seen: unknown[] = []
		const ask = questionsOverPermission(
			's1',
			(async (request: unknown) => {
				seen.push(request)
				return { kind: 'approve_all' }
			}) as never,
			never,
		)
		await expect(browserWindowApprover(() => ask)(subject)).resolves.toBe('allow')
		expect(seen[0]).toEqual({
			sessionId: 's1',
			toolCalls: [
				{
					id: 'browser-window-1',
					name: BROWSER_WINDOW_TOOL,
					input: { app: 'Brave' },
					isDestructive: false,
					alwaysAsk: true,
				},
			],
		})
	})

	it('is a no when Desktop rejects, and unavailable when the request fails', async () => {
		const rejected = questionsOverPermission(
			's1',
			(async () => ({ kind: 'reject' })) as never,
			never,
		)
		await expect(browserWindowApprover(() => rejected)(subject)).resolves.toBe('deny')
		const failed = questionsOverPermission(
			's1',
			(async () => {
				throw new Error('closed')
			}) as never,
			never,
		)
		await expect(browserWindowApprover(() => failed)(subject)).resolves.toBe('unavailable')
	})
})
