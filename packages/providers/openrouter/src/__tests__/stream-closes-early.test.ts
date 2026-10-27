import { afterEach, describe, expect, it, vi } from 'vitest'

import { OpenRouterProvider } from '../client.js'

/** A stream that closes without a finish reason was cut by the connection. */

afterEach(() => {
	vi.unstubAllGlobals()
})

const frame = (finishReason: string | null, content = 'x') =>
	`data: ${JSON.stringify({
		id: 'gen-test',
		choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
	})}\n\n`

async function drain(body: string): Promise<unknown[]> {
	vi.stubGlobal(
		'fetch',
		vi
			.fn()
			.mockResolvedValue(
				new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
			),
	)
	const provider = new OpenRouterProvider({
		apiKey: 'test-key',
		baseUrl: 'https://example.test/api/v1',
	})
	const out: unknown[] = []
	for await (const chunk of provider.chatStream({
		model: 'm',
		messages: [{ role: 'user', content: 'hi' }],
	})) {
		out.push(chunk)
	}
	return out
}

describe('a stream that closes before it says it is over', () => {
	it('is a retryable network failure when it just ends', async () => {
		await expect(drain(frame(null, 'The first hal'))).rejects.toMatchObject({
			kind: 'network',
			providerId: 'openrouter',
		})
	})

	it('is a retryable network failure when only [DONE] closes it', async () => {
		await expect(drain(`${frame(null, 'The first hal')}data: [DONE]\n\n`)).rejects.toMatchObject({
			kind: 'network',
			providerId: 'openrouter',
		})
	})

	it('is not an error once a finish reason arrived', async () => {
		await expect(
			drain(`${frame(null, 'Done')}${frame('stop', '')}data: [DONE]\n\n`),
		).resolves.toHaveLength(2)
		await expect(drain(frame('stop'))).resolves.toHaveLength(1)
	})
})
