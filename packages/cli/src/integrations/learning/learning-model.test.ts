import { asSessionId } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import type { SideModel, SideRequest } from '../small-model/side-model.js'
import { createLearningLedger, createSideLearningModel } from './learning-model.js'

const usage = (totalTokens: number) => ({
	promptTokens: 0,
	completionTokens: 0,
	totalTokens,
	cachedTokens: 0,
	cacheWriteTokens: 0,
})

function build(answer: (request: SideRequest) => Promise<string | undefined>, tokens = 42) {
	const ledger = createLearningLedger()
	const requests: SideRequest[] = []
	const side: SideModel = {
		route: async () => ({ providerId: 'p', model: 'm', source: 'configured' }),
		smallProvider: async () => undefined,
		ask: async (request) => {
			requests.push(request)
			// The real side model charges the ledger around the provider call.
			const out = await ledger.chargeNow({
				turnId: request.turnId,
				sessionId: request.sessionId,
				estimatedPromptTokens: 1,
				signal: request.signal,
				request: async () => ({ value: (await answer(request)) ?? '', usage: usage(tokens) }),
			})
			return out?.trim() ? out : undefined
		},
	}
	const learning = createSideLearningModel({
		side,
		ledger,
		sessionId: asSessionId('11111111-1111-4111-8111-111111111111'),
	})
	return { learning, requests }
}
const call = (learning: ReturnType<typeof build>['learning'], prompt = 'p') =>
	learning.model({ system: 's', prompt, maxTokens: 10, signal: new AbortController().signal })

describe('side learning model', () => {
	it('returns the text with the tokens the call used', async () => {
		const { learning, requests } = build(async () => 'hello', 77)
		expect(await call(learning)).toEqual({ text: 'hello', tokens: 77, costUsd: null })
		expect(requests[0]).toMatchObject({ instruction: 's', body: 'p', timing: 'in-turn' })
	})

	it('names the route it would use', async () => {
		const { learning } = build(async () => 'x')
		expect(await learning.route(new AbortController().signal)).toBe('p/m')
	})

	it('fails the call, not silently, when the model gives no answer', async () => {
		const { learning } = build(async () => undefined)
		await expect(call(learning)).rejects.toThrow(/did not answer/)
	})

	it('runs calls one at a time so counts cannot swap', async () => {
		const order: string[] = []
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const { learning } = build(async (request) => {
			order.push(`start ${request.body}`)
			if (request.body === 'one') await gate
			order.push(`end ${request.body}`)
			return request.body
		})
		const first = call(learning, 'one')
		const second = call(learning, 'two')
		await new Promise((resolve) => setImmediate(resolve))
		release()
		await Promise.all([first, second])
		expect(order).toEqual(['start one', 'end one', 'start two', 'end two'])
	})

	it('refuses to start a call that is already cancelled', async () => {
		const { learning, requests } = build(async () => 'x')
		const controller = new AbortController()
		controller.abort(new Error('stop'))
		await expect(
			learning.model({ system: 's', prompt: 'p', maxTokens: 1, signal: controller.signal }),
		).rejects.toThrow('stop')
		expect(requests).toHaveLength(0)
	})
})
