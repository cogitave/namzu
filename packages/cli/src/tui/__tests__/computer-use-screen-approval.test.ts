import { describe, expect, it, vi } from 'vitest'
import type { QuestionAnswer, QuestionFn } from '../agent.js'
import { screenApprover, screenQuestionApp } from '../computer-use-screen-approval.js'

const subject = { app: 'Editor', exe: 'editor.exe' }

describe('the one question computer use asks', () => {
	it('is unavailable where nobody can answer, so the run parks instead of asking', async () => {
		await expect(screenApprover(() => undefined)(subject)).resolves.toBe('unavailable')
	})

	it.each([
		[{ kind: 'answer', selectedOptionIds: ['allow'] }, 'allow'],
		[{ kind: 'answer', selectedOptionIds: ['deny'] }, 'deny'],
		[{ kind: 'abort' }, 'deny'],
		[{ kind: 'skip' }, 'unavailable'],
	] as [QuestionAnswer, string][])('maps %j to %s', async (answer, expected) => {
		const ask = vi.fn<QuestionFn>(async () => answer)
		await expect(screenApprover(() => ask)(subject)).resolves.toBe(expected)
		const asked = ask.mock.calls[0]?.[0]
		expect(asked?.question).toBe('Let Editor use the screen for a moment?')
		expect(asked?.options.map((option) => option.id)).toEqual(['allow', 'deny'])
	})
})

describe('the screen question names its application', () => {
	it('reads the name back from the question it built, and nothing from another', async () => {
		const ask = vi.fn<QuestionFn>(async () => ({ kind: 'skip' }))
		await screenApprover(() => ask)({ app: 'Editor' })
		await screenApprover(() => ask)({ app: ' ' })
		const [first, second] = ask.mock.calls.map((call) => call[0])
		expect(screenQuestionApp(first as never)).toBe('Editor')
		expect(screenQuestionApp(second as never)).toBe('An application')
		expect(
			screenQuestionApp({ questionId: 'q1', question: 'Let X use the screen for a moment?' }),
		).toBe(undefined)
	})

	it('does not take another question that merely starts like one for the screen question', () => {
		expect(
			screenQuestionApp({ questionId: 'screen-x', question: 'Which file should I open?' }),
		).toBe(undefined)
	})
})
