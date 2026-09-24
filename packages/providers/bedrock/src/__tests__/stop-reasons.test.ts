import type { StreamChunk } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { BedrockProvider } from '../index.js'

/**
 * The runtime tells a tool call the output stopped from one the model wrote
 * badly by the finish reason alone, and it refuses tool-call arguments that
 * arrive before the call's id.
 */

async function chunksOf(events: unknown[]): Promise<StreamChunk[]> {
	const provider = new BedrockProvider({ region: 'us-east-1' })
	;(provider as unknown as { client: unknown }).client = {
		send: async () => ({
			$metadata: { requestId: 'request-test' },
			stream: (async function* () {
				for (const event of events) yield event
			})(),
		}),
	}
	const out: StreamChunk[] = []
	for await (const chunk of provider.chatStream({
		model: 'anthropic.claude-sonnet-5-v1:0',
		messages: [{ role: 'user', content: 'q' }],
	})) {
		out.push(chunk)
	}
	return out
}

describe('Bedrock stop reasons', () => {
	it.each([
		['max_tokens', 'length'],
		['model_context_window_exceeded', 'length'],
		['guardrail_intervened', 'content_filter'],
		['content_filtered', 'content_filter'],
		['tool_use', 'tool_calls'],
		['end_turn', 'stop'],
	])('reports %s as %s', async (stopReason, expected) => {
		const chunks = await chunksOf([{ messageStop: { stopReason } }])
		expect(chunks.find((chunk) => chunk.finishReason)?.finishReason).toBe(expected)
	})
})

describe('Bedrock tool-call ids', () => {
	it('announces the id it keeps, so the arguments never arrive before one', async () => {
		const chunks = await chunksOf([
			{ contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { name: 'write' } } } },
			{ contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"a":1}' } } } },
			{ messageStop: { stopReason: 'tool_use' } },
		])

		const opening = chunks[0]?.delta.toolCalls?.[0]
		expect(opening?.id).toMatch(/^tool-\d+$/)
		expect(opening?.function?.name).toBe('write')
	})
})
