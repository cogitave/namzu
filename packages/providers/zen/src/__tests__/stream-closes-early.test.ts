import { type Message, collectChatCompletion } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZenProvider } from '../client.js'

afterEach(() => {
	vi.unstubAllGlobals()
})

const sse = (frames: readonly unknown[]): string =>
	frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')

const messages: Message[] = [{ role: 'user', content: 'Hi' }]

async function run(protocol: 'chat' | 'responses' | 'messages' | 'google', body: string) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })),
	)
	const provider = new ZenProvider({ apiKey: 'opencode-early-close-secret', protocol }, 'zen')
	return collectChatCompletion(
		provider.chatStream({ model: 'some-model', messages, maxTokens: 64 }),
	)
}

const chatCut = sse([
	{
		id: 'c1',
		object: 'chat.completion.chunk',
		created: 1,
		model: 'm',
		choices: [
			{ index: 0, delta: { role: 'assistant', content: 'The first hal' }, finish_reason: null },
		],
	},
])
const chatDone = sse([
	{
		id: 'c1',
		object: 'chat.completion.chunk',
		created: 1,
		model: 'm',
		choices: [{ index: 0, delta: { role: 'assistant', content: 'Done' }, finish_reason: null }],
	},
	{
		id: 'c1',
		object: 'chat.completion.chunk',
		created: 1,
		model: 'm',
		choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	},
])
const messagesCut = sse([
	{
		type: 'message_start',
		message: {
			id: 'm1',
			type: 'message',
			role: 'assistant',
			model: 'm',
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 8, output_tokens: 0 },
		},
	},
	{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
	{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The first hal' } },
])
const responsesCut = sse([
	{ type: 'response.created', response: { id: 'r1', created_at: 1, model: 'm' } },
	{
		type: 'response.output_item.added',
		output_index: 0,
		item: { type: 'message', id: 'i1', role: 'assistant', content: [] },
	},
	{
		type: 'response.output_text.delta',
		item_id: 'i1',
		output_index: 0,
		content_index: 0,
		delta: 'The first hal',
	},
])
const googleCut = sse([
	{ candidates: [{ content: { role: 'model', parts: [{ text: 'The first hal' }] } }] },
])

describe('a stream that closes before it says it is over', () => {
	it.each([
		['chat', chatCut],
		['messages', messagesCut],
		['responses', responsesCut],
		['google', googleCut],
	] as const)('is a retryable network failure on the %s wire', async (protocol, body) => {
		await expect(run(protocol, body)).rejects.toMatchObject({
			kind: 'network',
			providerId: 'zen',
		})
	})

	it('is not an error once the finish reason arrived', async () => {
		const response = await run('chat', chatDone)
		expect(response.finishReason).toBe('stop')
	})
})
