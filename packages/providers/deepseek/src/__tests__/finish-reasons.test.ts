import { type ChatCompletionParams, type StreamChunk, isProviderRequestError } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { DeepSeekProvider } from '../client.js'

/**
 * `insufficient_system_resource` means the server stopped generating for
 * want of capacity. It fell to 'stop', so a cut-off answer read as finished,
 * and a tool call it cut off as one the model wrote badly.
 */

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

async function drain(provider: DeepSeekProvider): Promise<StreamChunk[]> {
	const out: StreamChunk[] = []
	for await (const c of provider.chatStream({
		model: 'deepseek-v4-flash',
		messages: [],
		thinking: { type: 'disabled' },
	} as ChatCompletionParams)) {
		out.push(c)
	}
	return out
}

describe('DeepSeek finish reasons', () => {
	it('fails a stream the server interrupted for lack of resources', async () => {
		const provider = providerOver([
			{ id: 'a', choices: [{ delta: { content: 'half an ans' } }] },
			{ id: 'a', choices: [{ delta: {}, finish_reason: 'insufficient_system_resource' }] },
		])
		const error = await drain(provider).then(
			() => undefined,
			(err: unknown) => err,
		)
		expect(isProviderRequestError(error)).toBe(true)
		expect(error).toMatchObject({
			kind: 'server',
			providerId: 'deepseek',
			detail: 'the server interrupted generation for lack of resources',
		})
	})

	it('still reports a length cut as length', async () => {
		const out = await drain(
			providerOver([{ id: 'a', choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] }]),
		)
		expect(out.at(-1)?.finishReason).toBe('length')
	})
})
