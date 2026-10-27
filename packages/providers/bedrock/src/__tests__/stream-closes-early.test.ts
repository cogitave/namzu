import { describe, expect, it } from 'vitest'

import { BedrockProvider } from '../client.js'

/** A stream that closes before the stop event was cut by the connection. */
function providerOver(events: unknown[]): BedrockProvider {
	const provider = new BedrockProvider({ region: 'us-east-1' })
	;(provider as unknown as { client: unknown }).client = {
		send: async () => ({
			$metadata: { requestId: 'request-test' },
			stream: (async function* () {
				for (const e of events) yield e
			})(),
		}),
	}
	return provider
}

const drain = async (provider: BedrockProvider) => {
	const out: unknown[] = []
	for await (const c of provider.chatStream({
		model: 'anthropic.claude-haiku-4-5-20251001-v1:0',
		messages: [{ role: 'user', content: 'q' }],
	})) {
		out.push(c)
	}
	return out
}

describe('a stream that closes before it says it is over', () => {
	it('is a retryable network failure, not a finished answer', async () => {
		const provider = providerOver([
			{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'The first hal' } } },
		])
		await expect(drain(provider)).rejects.toMatchObject({ kind: 'network', providerId: 'bedrock' })
	})

	it('is not an error once the stop event arrived', async () => {
		const provider = providerOver([{ messageStop: { stopReason: 'end_turn' } }])
		await expect(drain(provider)).resolves.toHaveLength(1)
	})
})
