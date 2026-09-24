import { type StreamChunk, collectChatCompletion } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HttpProvider } from '../client.js'

/**
 * The runtime tells a tool call the output stopped from one the model wrote
 * badly by the finish reason alone. The OpenAI dialect cast the server's
 * `finish_reason` straight through, so a spelling outside the SDK's four
 * reached the runtime as-is; the Anthropic dialect reported the context
 * window and a refusal as a normal finish, and announced a tool call without
 * the id its arguments then carried.
 */

afterEach(() => {
	vi.unstubAllGlobals()
})

function sse(frames: string[]): Response {
	return new Response(`${frames.join('\n\n')}\n\n`, {
		status: 200,
		headers: { 'Content-Type': 'text/event-stream' },
	})
}

async function chunksOf(dialect: 'openai' | 'anthropic', frames: string[]): Promise<StreamChunk[]> {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => sse(frames)),
	)
	const provider = new HttpProvider({ baseURL: 'https://example.test/v1', apiKey: 'k', dialect })
	const out: StreamChunk[] = []
	for await (const chunk of provider.chatStream({
		model: 'm',
		messages: [{ role: 'user', content: 'q' }],
	})) {
		out.push(chunk)
	}
	return out
}

const openAiFinish = (reason: string | null) =>
	`data: ${JSON.stringify({ id: 'r', choices: [{ delta: {}, finish_reason: reason }] })}`

describe('HTTP provider, OpenAI dialect finish reasons', () => {
	it.each([
		['length', 'length'],
		['tool_calls', 'tool_calls'],
		['function_call', 'tool_calls'],
		['content_filter', 'content_filter'],
		['stop', 'stop'],
		['eos', 'stop'],
	])('reports %s as %s', async (reason, expected) => {
		const chunks = await chunksOf('openai', [openAiFinish(reason), 'data: [DONE]'])
		expect(chunks.map((chunk) => chunk.finishReason).filter(Boolean)).toEqual([expected])
	})

	it('reports no finish reason for the null every frame but the last carries', async () => {
		const chunks = await chunksOf('openai', [openAiFinish(null), 'data: [DONE]'])
		expect(chunks[0]?.finishReason).toBeUndefined()
	})

	it.each(['max_tokens', 'max_output_tokens'])(
		"reports a server's own name for the output limit, %s, as length",
		async (reason) => {
			const chunks = await chunksOf('openai', [openAiFinish(reason), 'data: [DONE]'])
			const finish = chunks.find((chunk) => chunk.finishReason)
			expect(finish?.finishReason).toBe('length')
			expect(finish?.finishDetail).toBeUndefined()
		},
	)

	it.each([
		'model_length',
		'context_length',
		'context_length_exceeded',
		'model_context_window_exceeded',
	])('reports %s as a length finish at the context window', async (reason) => {
		// It read as a normal finish, so a tool call the full window cut off
		// was reported as one the model finished and got wrong.
		const chunks = await chunksOf('openai', [openAiFinish(reason), 'data: [DONE]'])
		const finish = chunks.find((chunk) => chunk.finishReason)
		expect(finish?.finishReason).toBe('length')
		expect(finish?.finishDetail).toBe('context_window')
	})

	it('fails the stream on an error finish instead of calling it a normal one', async () => {
		await expect(chunksOf('openai', [openAiFinish('error'), 'data: [DONE]'])).rejects.toMatchObject(
			{
				kind: 'server',
				providerId: 'http',
			},
		)
	})

	it('reports no finish reason for a value it does not know, rather than a normal finish', async () => {
		const chunks = await chunksOf('openai', [openAiFinish('recitation_blocked'), 'data: [DONE]'])
		expect(chunks.some((chunk) => chunk.finishReason !== undefined)).toBe(false)
	})
})

describe('HTTP provider, OpenAI dialect tool calls with no index', () => {
	it('assembles parallel calls from a server that leaves `index` out', async () => {
		// Passed through as it came, the missing index used to put both calls
		// on one index, and the runtime refused the stream as a reused index.
		const frame = (toolCall: Record<string, unknown>) =>
			`data: ${JSON.stringify({ id: 'r', choices: [{ delta: { tool_calls: [toolCall] }, finish_reason: null }] })}`
		const chunks = await chunksOf('openai', [
			frame({ id: 'call_a', type: 'function', function: { name: 'read', arguments: '' } }),
			frame({ function: { arguments: '{"path":"a.md"}' } }),
			frame({ id: 'call_b', type: 'function', function: { name: 'read', arguments: '' } }),
			frame({ function: { arguments: '{"path":"b.md"}' } }),
			openAiFinish('tool_calls'),
			'data: [DONE]',
		])
		const response = await collectChatCompletion(
			(async function* () {
				yield* chunks
			})(),
		)
		expect(response.message.toolCalls?.map((call) => [call.id, call.function.arguments])).toEqual([
			['call_a', '{"path":"a.md"}'],
			['call_b', '{"path":"b.md"}'],
		])
	})
})

const anthropicFrames = (stopReason: string, toolUse = false) => [
	'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}',
	...(toolUse
		? [
				'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"write"}}',
				'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}',
			]
		: []),
	`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${stopReason}"}}`,
	'event: message_stop\ndata: {"type":"message_stop"}',
]

describe('HTTP provider, Anthropic dialect', () => {
	it.each([
		['max_tokens', 'length'],
		['model_context_window_exceeded', 'length'],
		['refusal', 'content_filter'],
		['tool_use', 'tool_calls'],
		['end_turn', 'stop'],
	])('reports %s as %s', async (stopReason, expected) => {
		const chunks = await chunksOf('anthropic', anthropicFrames(stopReason))
		expect(chunks.find((chunk) => chunk.finishReason)?.finishReason).toBe(expected)
	})

	it('marks a context-window stop as one, so the turn loop does not continue it', async () => {
		const window = await chunksOf('anthropic', anthropicFrames('model_context_window_exceeded'))
		expect(window.find((chunk) => chunk.finishReason)?.finishDetail).toBe('context_window')
		const output = await chunksOf('anthropic', anthropicFrames('max_tokens'))
		expect(output.find((chunk) => chunk.finishReason)?.finishDetail).toBeUndefined()
	})

	it('opens a tool call with the id its arguments carry', async () => {
		const chunks = await chunksOf('anthropic', anthropicFrames('tool_use', true))
		const calls = chunks.flatMap((chunk) => chunk.delta.toolCalls ?? [])
		expect(calls[0]?.id).toMatch(/^tool-\d+$/)
		expect(calls[1]?.id).toBe(calls[0]?.id)
	})
})
