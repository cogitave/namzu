import { describe, expect, it } from 'vitest'

import { LMStudioProvider } from '../client.js'

/** A reply that stops without saying why, or because the model went away, is cut. */
function providerAnswering(stopReason: string | undefined): LMStudioProvider {
	const provider = new LMStudioProvider({ model: 'local-model' })
	const prediction = {
		async *[Symbol.asyncIterator]() {
			yield { content: 'The first hal' }
		},
		// biome-ignore lint/suspicious/noThenProperty: the SDK's prediction is both iterable and awaitable
		then: (resolve: (value: unknown) => void) =>
			resolve({
				stats: {
					...(stopReason !== undefined ? { stopReason } : {}),
					promptTokensCount: 3,
					predictedTokensCount: 4,
				},
			}),
	}
	;(provider as unknown as { clientInstance: unknown }).clientInstance = {
		llm: { model: async () => ({ respond: () => prediction }) },
	}
	return provider
}

const drain = async (provider: LMStudioProvider) => {
	const out: unknown[] = []
	for await (const chunk of provider.chatStream({
		model: 'local-model',
		messages: [{ role: 'user', content: 'q' }],
	})) {
		out.push(chunk)
	}
	return out
}

describe('a reply that ends before it says it is over', () => {
	it.each([undefined, 'failed', 'modelUnloaded'])(
		'is a retryable network failure when the stop reason is %s',
		async (reason) => {
			await expect(drain(providerAnswering(reason))).rejects.toMatchObject({
				kind: 'network',
				providerId: 'lmstudio',
			})
		},
	)

	it.each(['eosFound', 'toolCalls', 'maxPredictedTokensReached'])(
		'is not an error when the stop reason is %s',
		async (reason) => {
			await expect(drain(providerAnswering(reason))).resolves.toHaveLength(2)
		},
	)
})
