import { describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createUserMessage } from '../../types/message/index.js'
import type { Message } from '../../types/message/index.js'
import type { PrepareStepContext } from '../../types/session/prepare-step.js'
import { generateSessionId, generateTurnId } from '../../utils/id.js'
import { createEvidenceQueryResolver, referentIsInView } from '../evidence-query.js'

const reply =
	'Budgets/: the README says no code reads it, and it belongs to the finance team. I left it out of the import.'
const history = [
	{
		position: 0,
		role: 'user',
		text: 'What should I ignore in this repo?',
		truncated: false,
	},
	{ position: 1, role: 'assistant', text: reply, truncated: false },
]
const summary: Message = {
	role: 'system',
	content: 'Earlier turns were summarized.',
	source: { type: 'compaction-summary' },
}

describe('the planner is skipped when the question points at the last reply', () => {
	it('skips when nothing was shed, the last reply is whole and shares a subject word', () => {
		const messages = [createUserMessage('x'), createAssistantMessage(reply)]
		expect(referentIsInView('Why did you mention Budgets?', history, messages)).toBe(true)
	})

	it('does not skip once content was shed', () => {
		expect(referentIsInView('Why did you mention Budgets?', history, [summary])).toBe(false)
	})

	it('does not skip when the question shares no subject word with the reply', () => {
		expect(referentIsInView('Why did you pick that one?', history, [])).toBe(false)
	})

	it('does not skip when the reply is shown only in part', () => {
		const partial = [history[0]!, { ...history[1]!, truncated: true }]
		expect(referentIsInView('Why did you mention Budgets?', partial, [])).toBe(false)
	})

	it('does not skip when the newest earlier message is the operator, not a reply', () => {
		expect(referentIsInView('Why did you mention Budgets?', [history[0]!], [])).toBe(false)
	})

	it('does not count a word that only says what kind of question it is', () => {
		const generic = [
			history[0]!,
			{
				position: 1,
				role: 'assistant',
				text: 'I would explain that again.',
				truncated: false,
			},
		]
		expect(referentIsInView('Can you explain that again?', generic, [])).toBe(false)
	})

	it('makes no planning request for such a follow-up, and one when the referent is gone', async () => {
		const generateText = vi.fn(async () => ({
			text: '{"mode":"none","time":"unspecified","termIds":[],"basis":[]}',
			usage: {
				promptTokens: 1,
				completionTokens: 1,
				totalTokens: 2,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
			servedBy: {} as never,
		}))
		const question = createUserMessage('Why did you mention Budgets?')
		const base = {
			sessionId: generateSessionId(),
			turnId: generateTurnId(),
			stepNumber: 1,
			steps: [],
			prepared: {},
			latestUserMessage: question,
			generateText,
		} as unknown as PrepareStepContext
		const resolver = createEvidenceQueryResolver()
		const inView = await resolver(
			{
				...base,
				messages: [
					createUserMessage('What should I ignore in this repo?'),
					createAssistantMessage(reply),
					question,
				],
			},
			question.content as string,
		)
		expect(inView).toBeUndefined()
		expect(generateText).not.toHaveBeenCalled()
		await createEvidenceQueryResolver()(
			{
				...base,
				turnId: generateTurnId(),
				messages: [
					summary,
					createUserMessage('What should I ignore in this repo?'),
					createAssistantMessage(reply),
					question,
				],
			},
			question.content as string,
		)
		expect(generateText).toHaveBeenCalledTimes(1)
	})
})
