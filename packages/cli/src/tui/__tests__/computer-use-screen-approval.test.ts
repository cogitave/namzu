import { describe, expect, it, vi } from 'vitest'
import type { QuestionAnswer, QuestionFn } from '../agent.js'
import { screenApprover } from '../computer-use-screen-approval.js'

const subject = { app: 'Notepad', exe: 'notepad.exe' }

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
		expect(asked?.question).toBe('Let Notepad use the screen for a moment?')
		expect(asked?.options.map((option) => option.id)).toEqual(['allow', 'deny'])
	})
})
