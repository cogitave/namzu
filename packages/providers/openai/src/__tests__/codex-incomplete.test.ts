import type { StreamChunk } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { CodexProvider } from '../index.js'

/**
 * `response.incomplete` — the backend's output budget or a content filter
 * stopped the response — was not handled. The stream just ended with no
 * finish reason, so a length cut looked like a dropped connection, the
 * runtime's auto-continuation never fired, and a tool call it cut off could
 * not be told from one the model wrote badly.
 */

async function chunksOf(reason: 'max_output_tokens' | 'content_filter' | undefined) {
	const create = vi.fn(async () =>
		(async function* () {
			yield { type: 'response.created', response: { id: 'resp_1' } }
			yield {
				type: 'response.output_item.added',
				output_index: 0,
				item: {
					type: 'function_call',
					id: 'fc_1',
					call_id: 'call_1',
					name: 'write',
					arguments: '',
				},
			}
			yield {
				type: 'response.function_call_arguments.delta',
				item_id: 'fc_1',
				output_index: 0,
				delta: '{"content":"half',
			}
			yield {
				type: 'response.incomplete',
				response: {
					id: 'resp_1',
					incomplete_details: reason ? { reason } : null,
					output: [],
					usage: { input_tokens: 3, output_tokens: 64, total_tokens: 67 },
				},
			}
		})(),
	)
	const provider = new CodexProvider({ accessToken: 'fixture', accountId: 'fixture', model: 'm' })
	;(provider as unknown as { client: unknown }).client = { responses: { create } }
	const chunks: StreamChunk[] = []
	for await (const chunk of provider.chatStream({
		model: 'm',
		messages: [{ role: 'user', content: 'write it' }],
	})) {
		chunks.push(chunk)
	}
	return chunks
}

describe('Codex incomplete responses', () => {
	it('reports an output-budget stop as length, with its usage', async () => {
		const chunks = await chunksOf('max_output_tokens')
		expect(chunks.at(-1)).toMatchObject({
			finishReason: 'length',
			usage: { promptTokens: 3, completionTokens: 64 },
		})
		expect(chunks.at(-1)).not.toHaveProperty('replayState')
	})

	it('reports a content-filter stop as content_filter', async () => {
		expect((await chunksOf('content_filter')).at(-1)?.finishReason).toBe('content_filter')
	})

	it('reports an incomplete response with no stated reason as length', async () => {
		expect((await chunksOf(undefined)).at(-1)?.finishReason).toBe('length')
	})
})
