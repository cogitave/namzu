import type { ChatCompletionParams, StreamChunk } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { AnthropicProvider } from '../client.js'

/**
 * The runtime tells a tool call the output stopped from one the model wrote
 * badly by the finish reason alone. `model_context_window_exceeded` and
 * `refusal` both end the response where it stands — possibly inside a
 * tool_use block — and both were reported as 'stop', a normal finish.
 */

function providerOver(events: unknown[]) {
	const provider = new AnthropicProvider({ apiKey: 'test-key' })
	;(provider as unknown as { client: { messages: { create: unknown } } }).client = {
		messages: {
			create: vi.fn(async () =>
				(async function* () {
					for (const event of events) yield event
				})(),
			),
		},
	}
	return provider
}

async function finishFor(stopReason: string): Promise<StreamChunk | undefined> {
	const events = [
		{ type: 'message_start', message: { id: 'msg_1' } },
		{
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'toolu_1', name: 'write' },
		},
		{
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'input_json_delta', partial_json: '{"content":"half' },
		},
		{ type: 'content_block_stop', index: 0 },
		{ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 9 } },
		{ type: 'message_stop' },
	]
	let finish: StreamChunk | undefined
	for await (const chunk of providerOver(events).chatStream({
		model: 'm',
		messages: [{ role: 'user', content: 'q' }],
	} as ChatCompletionParams)) {
		if (chunk.finishReason) finish = chunk
	}
	return finish
}

async function finishReasonFor(stopReason: string): Promise<StreamChunk['finishReason']> {
	return (await finishFor(stopReason))?.finishReason
}

describe('Anthropic stop reasons', () => {
	it('marks a context-window stop, so the turn loop does not continue a reply that filled it', async () => {
		expect((await finishFor('model_context_window_exceeded'))?.finishDetail).toBe('context_window')
		expect((await finishFor('max_tokens'))?.finishDetail).toBeUndefined()
	})

	it.each([
		['max_tokens', 'length'],
		['model_context_window_exceeded', 'length'],
		['refusal', 'content_filter'],
		['tool_use', 'tool_calls'],
		['end_turn', 'stop'],
	])('reports %s as %s', async (stopReason, expected) => {
		expect(await finishReasonFor(stopReason)).toBe(expected)
	})
})

describe('Anthropic tool calls whose arguments do not parse', () => {
	async function chunksOf(partialJson: string[], stopReason: string): Promise<StreamChunk[]> {
		const events = [
			{ type: 'message_start', message: { id: 'msg_1' } },
			{
				type: 'content_block_start',
				index: 0,
				content_block: { type: 'tool_use', id: 'toolu_1', name: 'ask' },
			},
			...partialJson.map((partial_json) => ({
				type: 'content_block_delta',
				index: 0,
				delta: { type: 'input_json_delta', partial_json },
			})),
			{ type: 'content_block_stop', index: 0 },
			{ type: 'message_delta', delta: { stop_reason: stopReason } },
			{ type: 'message_stop' },
		]
		const out: StreamChunk[] = []
		for await (const chunk of providerOver(events).chatStream({
			model: 'm',
			messages: [{ role: 'user', content: 'q' }],
		} as ChatCompletionParams)) {
			out.push(chunk)
		}
		return out
	}

	// The driver parsed every block's JSON for its search-replay record and
	// threw on this, failing the stream as "malformed data" before the block
	// close and the finish reason could reach the runtime — which then called
	// every such call cut off.
	it('passes malformed JSON through to the runtime, with its block close and finish reason', async () => {
		const chunks = await chunksOf(['{"q":"a" "b"}'], 'tool_use')
		expect(chunks.some((chunk) => chunk.delta.toolCallEnd?.id === 'toolu_1')).toBe(true)
		expect(chunks.find((chunk) => chunk.finishReason)?.finishReason).toBe('tool_calls')
	})

	it('passes a call with no arguments through', async () => {
		const chunks = await chunksOf([''], 'tool_use')
		expect(chunks.some((chunk) => chunk.delta.toolCallEnd?.id === 'toolu_1')).toBe(true)
	})
})
