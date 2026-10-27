import { describe, expect, it } from 'vitest'

import { DeepSeekProvider } from '../client.js'

/** A stream that closes without a finish reason was cut by the connection. */
function providerOver(chunks: unknown[]): DeepSeekProvider {
	const provider = new DeepSeekProvider({ apiKey: 'sk-test' })
	;(provider as unknown as { client: unknown }).client = {
		chat: {
			completions: {
				create: async () => ({
					async *[Symbol.asyncIterator]() {
						for (const c of chunks) yield c
					},
				}),
			},
		},
	}
	return provider
}

const drain = async (provider: DeepSeekProvider) => {
	const out: unknown[] = []
	for await (const c of provider.chatStream({
		model: 'deepseek-chat',
		messages: [{ role: 'user', content: 'q' }],
	})) {
		out.push(c)
	}
	return out
}

describe('a stream that closes before it says it is over', () => {
	it('is a retryable network failure, not a finished answer', async () => {
		const provider = providerOver([
			{
				id: 'c1',
				choices: [{ index: 0, delta: { content: 'The first hal' }, finish_reason: null }],
			},
		])
		await expect(drain(provider)).rejects.toMatchObject({ kind: 'network', providerId: 'deepseek' })
	})

	it('is not an error once a finish reason arrived', async () => {
		const provider = providerOver([
			{ id: 'c1', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] },
		])
		await expect(drain(provider)).resolves.toHaveLength(1)
	})
})
