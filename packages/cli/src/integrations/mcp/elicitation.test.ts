import type { MCPElicitationRequest } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import type { QuestionAnswer, QuestionFn, UserQuestion } from '../../tui/agent.js'
import { MAX_ELICITATION_FIELDS, elicitThroughQuestions } from './elicitation.js'

const live = new AbortController().signal

function request(
	properties: Record<string, unknown>,
	required: string[] = [],
): MCPElicitationRequest {
	return {
		serverName: 'notes',
		message: 'Tell me more',
		requestedSchema: { type: 'object', properties, required },
	}
}

/** An answerer that replies from a script and records every card it was shown. */
function scripted(replies: QuestionAnswer[]) {
	const shown: UserQuestion[] = []
	const ask: QuestionFn = async (question) => {
		shown.push(question)
		return replies.shift() ?? { kind: 'skip' }
	}
	return { ask, shown }
}

const answer = (
	...entries: { questionId: string; selectedOptionIds?: string[]; freeText?: string }[]
): QuestionAnswer => ({
	kind: 'answer',
	selectedOptionIds: [],
	answers: entries.map((e) => ({ selectedOptionIds: [], ...e })),
})

describe('elicitThroughQuestions', () => {
	it('declines at once when nobody can answer', async () => {
		const handler = elicitThroughQuestions(() => undefined)
		expect(await handler(request({ a: { type: 'string' } }), { signal: live })).toEqual({
			action: 'decline',
		})
	})

	it('shows one question per field, led by who asks and what for', async () => {
		const { ask, shown } = scripted([{ kind: 'skip' }])
		const handler = elicitThroughQuestions(() => ask)
		await handler(
			request({ name: { type: 'string', title: 'Name' }, ok: { type: 'boolean' } }, ['name']),
			{ signal: live },
		)
		const items = shown[0]?.questions ?? []
		expect(items).toHaveLength(2)
		expect(items[0]?.question).toContain('notes asks: Tell me more')
		expect(items[0]?.question).toContain('Name')
		expect(items[0]?.allowFreeText).toBe(true)
		expect(items[1]?.options.map((o) => o.label)).toEqual(['Yes', 'No'])
		expect(items[1]?.question).toContain('(optional)')
	})

	it('turns answers into typed values', async () => {
		const { ask } = scripted([
			answer(
				{ questionId: 'f0', freeText: ' Ada ' },
				{ questionId: 'f1', freeText: '3' },
				{ questionId: 'f2', selectedOptionIds: ['yes'] },
				{ questionId: 'f3', selectedOptionIds: ['1'] },
				{ questionId: 'f4', selectedOptionIds: ['0', '1'] },
			),
		])
		const handler = elicitThroughQuestions(() => ask)
		const result = await handler(
			request({
				name: { type: 'string' },
				count: { type: 'integer' },
				agree: { type: 'boolean' },
				color: { type: 'string', enum: ['red', 'blue'], enumNames: ['Red', 'Blue'] },
				tags: {
					type: 'array',
					items: {
						anyOf: [
							{ const: 'a', title: 'A' },
							{ const: 'b', title: 'B' },
						],
					},
				},
			}),
			{ signal: live },
		)
		expect(result).toEqual({
			action: 'accept',
			content: { name: 'Ada', count: 3, agree: true, color: 'blue', tags: ['a', 'b'] },
		})
	})

	it('asks again with the reason when a value does not fit, then accepts', async () => {
		const { ask, shown } = scripted([
			answer({ questionId: 'f0', freeText: '40' }),
			answer({ questionId: 'f0', freeText: '7' }),
		])
		const handler = elicitThroughQuestions(() => ask)
		const result = await handler(
			request({ age: { type: 'integer', title: 'Age', maximum: 30 } }, ['age']),
			{ signal: live },
		)
		expect(shown).toHaveLength(2)
		expect(shown[1]?.question).toContain('"Age" must be at most 30.')
		expect(result).toEqual({ action: 'accept', content: { age: 7 } })
	})

	it('treats a missing required field like a bad value', async () => {
		const { ask, shown } = scripted([answer({ questionId: 'f1', freeText: 'x' }), { kind: 'skip' }])
		const handler = elicitThroughQuestions(() => ask)
		const result = await handler(
			request({ a: { type: 'string', title: 'A' }, b: { type: 'string' } }, ['a']),
			{ signal: live },
		)
		expect(shown[1]?.question).toContain('"A" needs an answer.')
		expect(result).toEqual({ action: 'decline' })
	})

	it('checks formats and lengths', async () => {
		const { ask, shown } = scripted([
			answer({ questionId: 'f0', freeText: 'not an email' }),
			answer({ questionId: 'f0', freeText: 'a@b.co' }),
		])
		const handler = elicitThroughQuestions(() => ask)
		const result = await handler(
			request({ mail: { type: 'string', title: 'Mail', format: 'email' } }, ['mail']),
			{ signal: live },
		)
		expect(shown[1]?.question).toContain('"Mail" must be a valid email.')
		expect(result).toEqual({ action: 'accept', content: { mail: 'a@b.co' } })
	})

	it('maps skip to decline and abort to cancel', async () => {
		const properties = { a: { type: 'string' } }
		const skip = elicitThroughQuestions(() => scripted([{ kind: 'skip' }]).ask)
		expect(await skip(request(properties), { signal: live })).toEqual({ action: 'decline' })
		const abort = elicitThroughQuestions(() => scripted([{ kind: 'abort' }]).ask)
		expect(await abort(request(properties), { signal: live })).toEqual({ action: 'cancel' })
	})

	it('cancels when the request was withdrawn while the card was up', async () => {
		const controller = new AbortController()
		const ask: QuestionFn = async () => {
			controller.abort()
			return answer({ questionId: 'f0', freeText: 'late' })
		}
		const handler = elicitThroughQuestions(() => ask)
		expect(
			await handler(request({ a: { type: 'string' } }), { signal: controller.signal }),
		).toEqual({ action: 'cancel' })
	})

	it('declines a form it cannot show instead of showing part of it', async () => {
		const { ask, shown } = scripted([])
		const handler = elicitThroughQuestions(() => ask)
		const nested = request({ a: { type: 'object' } })
		expect(await handler(nested, { signal: live })).toEqual({ action: 'decline' })
		const tooMany = request(
			Object.fromEntries(
				Array.from({ length: MAX_ELICITATION_FIELDS + 1 }, (_, i) => [`k${i}`, { type: 'string' }]),
			),
		)
		expect(await handler(tooMany, { signal: live })).toEqual({ action: 'decline' })
		expect(shown).toHaveLength(0)
	})

	it('strips terminal control characters from server text', async () => {
		const { ask, shown } = scripted([{ kind: 'skip' }])
		const handler = elicitThroughQuestions(() => ask)
		await handler(
			{
				serverName: 'x',
				message: 'hi\u001b[31m red',
				requestedSchema: { properties: { a: { type: 'string' } } },
			},
			{ signal: live },
		)
		expect(shown[0]?.question).not.toContain('\u001b')
	})
})
