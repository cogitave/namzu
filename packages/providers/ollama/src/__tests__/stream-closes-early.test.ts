import { describe, expect, it } from 'vitest'

import { OllamaProvider } from '../client.js'

/** A stream that closes before the server's final message was cut by the connection. */
function providerOver(chunks: unknown[]): OllamaProvider {
	const provider = new OllamaProvider({})
	;(provider as unknown as { client: unknown }).client = {
		chat: async () => ({
			async *[Symbol.asyncIterator]() {
				for (const c of chunks) yield c
			},
		}),
	}
	return provider
}

const drain = async (provider: OllamaProvider) => {
	const out: unknown[] = []
	for await (const c of provider.chatStream({
		model: 'llama3.1',
		messages: [{ role: 'user', content: 'q' }],
	})) {
		out.push(c)
	}
	return out
}

describe('a stream that closes before it says it is over', () => {
	it('is a retryable network failure, not a finished answer', async () => {
		const provider = providerOver([
			{ model: 'llama3.1', message: { role: 'assistant', content: 'partial' }, done: false },
		])
		await expect(drain(provider)).rejects.toMatchObject({ kind: 'network', providerId: 'ollama' })
	})

	it('is not an error once the final message arrived', async () => {
		const provider = providerOver([
			{ model: 'llama3.1', message: { role: 'assistant', content: 'ok' }, done: false },
			{
				model: 'llama3.1',
				message: { role: 'assistant', content: '' },
				done: true,
				done_reason: 'stop',
			},
		])
		await expect(drain(provider)).resolves.not.toHaveLength(0)
	})
})
