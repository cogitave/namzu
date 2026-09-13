import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '../../types/message/index.js'
import type { PrepareStepContext } from '../../types/run/prepare-step.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
} from '../../utils/id.js'
import { validateEvidenceQueryResolution } from '../evidence-query.js'
import { type EvidenceRecallRequest, createEvidenceRecallStep } from '../evidence-recall.js'

const previous = 'Inspect DELTA and OMEGA records together.'
const question = "What was that record's old code?"
const plan = {
	mode: 'ambiguous',
	time: 'past',
	termIds: [],
	basis: [{ message: 0, quote: 'DELTA and OMEGA records' }],
}
const scope = {
	tenantId: generateTenantId(),
	projectId: generateProjectId(),
	sessionId: generateSessionId(),
}
function setup() {
	const current = createUserMessage(question)
	const generateText = vi.fn(async () => ({ text: JSON.stringify(plan) }))
	const context = {
		runId: generateRunId(),
		stepNumber: 1,
		steps: [],
		messages: [createUserMessage(previous), current],
		latestUserMessage: current,
		prepared: { system: 'Existing policy', context: 'Earlier context' },
		generateText,
	} as unknown as PrepareStepContext
	const retrieve = vi.fn(async (_request: EvidenceRecallRequest) => ({
		candidates: [],
		scannedBytes: 0,
		incomplete: false,
	}))
	return { context, generateText, retrieve }
}

describe('unresolved conversation references', () => {
	it.each([
		{ ...plan, termIds: [0] },
		{ ...plan, basis: [] },
		{ ...plan, basis: [{ message: 0, quote: 'An invented subject' }] },
	])('rejects unsupported ambiguity claims (%j)', (invalid) => {
		expect(() =>
			validateEvidenceQueryResolution(JSON.stringify(invalid), question, [
				{ position: 8, role: 'user', text: previous, truncated: false },
			]),
		).toThrow()
	})
	it('carries a quoted interpretation into temporary context without searching or changing policy/history', async () => {
		const { context, generateText, retrieve } = setup()
		const before = structuredClone(context.messages)
		const recall = createEvidenceRecallStep({ scope, retrieve, resolveQuery: true })
		for (const stepNumber of [1, 2]) {
			const result = await recall({ ...context, stepNumber })
			expect(result?.context).toMatch(/^Earlier context\n\nConversation query planning note/)
			expect(result?.context).toContain('not retrieved evidence')
			expect(result?.context).toContain('interpretation may be mistaken')
			expect(result?.context).toContain('DELTA and OMEGA records')
			expect(result?.system).toBeUndefined()
			expect(result?.context?.length).toBeLessThan(6000)
		}
		expect(context.messages).toEqual(before)
		expect(context.prepared).toEqual({ system: 'Existing policy', context: 'Earlier context' })
		expect(generateText).toHaveBeenCalledTimes(1)
		expect(retrieve).not.toHaveBeenCalled()
	})
	it('drops the prior interpretation when a new operator input names a subject', async () => {
		const { context, generateText, retrieve } = setup()
		const recall = createEvidenceRecallStep({ scope, retrieve, resolveQuery: true })
		expect((await recall(context))?.context).toContain('ambiguous')
		generateText.mockResolvedValueOnce({
			text: JSON.stringify({ mode: 'direct', time: 'past', termIds: [], basis: [] }),
		})
		const clarification = createUserMessage('DELTA')
		expect(
			await recall({
				...context,
				latestUserMessage: clarification,
				messages: [...context.messages, clarification],
			}),
		).toBeUndefined()
		expect(generateText).toHaveBeenCalledTimes(2)
		expect(retrieve).toHaveBeenCalledOnce()
		expect(retrieve.mock.calls[0]?.[0]).toMatchObject({ terms: ['DELTA'] })
	})
	it('bounds the escaped interpretation and never emits partial quote JSON', async () => {
		const { context, generateText, retrieve } = setup()
		const quote = '\u0001'.repeat(200)
		generateText.mockResolvedValueOnce({
			text: JSON.stringify({
				...plan,
				basis: Array.from({ length: 3 }, (_, message) => ({ message, quote })),
			}),
		})
		const recall = createEvidenceRecallStep({ scope, retrieve, resolveQuery: true, maxChars: 2000 })
		expect(
			await recall({
				...context,
				messages: [
					...Array.from({ length: 3 }, () => createUserMessage(quote)),
					context.latestUserMessage!,
				],
			}),
		).toBeUndefined()
		expect(generateText).toHaveBeenCalledOnce()
		expect(retrieve).not.toHaveBeenCalled()
	})
	it('does not publish a late planning note after cancellation', async () => {
		const { context, generateText, retrieve } = setup()
		const abort = new AbortController()
		generateText.mockImplementationOnce(async () => {
			abort.abort(new Error('Operator stopped'))
			return { text: JSON.stringify(plan) }
		})
		await expect(
			createEvidenceRecallStep({ scope, retrieve, resolveQuery: true })({
				...context,
				signal: abort.signal,
			}),
		).rejects.toThrow('Operator stopped')
		expect(retrieve).not.toHaveBeenCalled()
	})
})
