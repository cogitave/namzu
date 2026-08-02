import type { ChatCompletionParams, StreamChunk } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { OllamaProvider } from '../client.js'

/**
 * The driver declared `supportsTools: false` and meant it: `chatStream`
 * never read `params.tools`, so no tool schema reached the model and the
 * runtime stripped the tool surface before every run. Honest, and useless
 * — the wire has carried tools all along.
 *
 * Everything here drives the real driver through a fake transport so the
 * request body is asserted as it goes out and the chunks as they come
 * back. A helper that only exercised the mapper would pass while the
 * driver still ignored the mapping.
 */

interface WireFrame {
	model?: string
	created_at?: string
	message?: {
		role: string
		content: string
		thinking?: string
		tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>
	}
	done?: boolean
	done_reason?: string
	prompt_eval_count?: number
	eval_count?: number
}

const DONE: WireFrame = {
	message: { role: 'assistant', content: '' },
	done: true,
	done_reason: 'stop',
	prompt_eval_count: 10,
	eval_count: 4,
}

function harness(frames: WireFrame[]) {
	const bodies: Record<string, unknown>[] = []
	const fetchImpl = (async (_url: string, init: { body: string }) => {
		bodies.push(JSON.parse(init.body))
		const encoder = new TextEncoder()
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const frame of frames) {
					controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`))
				}
				controller.close()
			},
		})
		return { ok: true, status: 200, headers: new Headers(), body } as unknown as Response
	}) as unknown as typeof fetch

	const provider = new OllamaProvider({ fetch: fetchImpl, model: 'local-model' })
	return { provider, bodies }
}

async function drain(
	provider: OllamaProvider,
	params: Partial<ChatCompletionParams> = {},
): Promise<StreamChunk[]> {
	const chunks: StreamChunk[] = []
	for await (const chunk of provider.chatStream({
		model: 'local-model',
		messages: [{ role: 'user', content: 'hi' }],
		...params,
	} as ChatCompletionParams)) {
		chunks.push(chunk)
	}
	return chunks
}

const TOOLS: ChatCompletionParams['tools'] = [
	{
		type: 'function',
		function: {
			name: 'read_file',
			description: 'Read a file',
			parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
		},
	},
]

describe('tool schemas on the request', () => {
	it('sends the tools the caller asked for', async () => {
		const { provider, bodies } = harness([DONE])
		await drain(provider, { tools: TOOLS })

		const sent = bodies[0]?.tools as
			| Array<{ function: { name: string; parameters: unknown } }>
			| undefined
		expect(sent).toHaveLength(1)
		expect(sent?.[0]?.function.name).toBe('read_file')
		expect(sent?.[0]?.function.parameters).toEqual({
			type: 'object',
			properties: { path: { type: 'string' } },
			required: ['path'],
		})
	})

	it('omits the field entirely when there are no tools', async () => {
		const { provider, bodies } = harness([DONE])
		await drain(provider)
		expect(bodies[0]).not.toHaveProperty('tools')
	})
})

describe('tool calls off the stream', () => {
	const callFrame: WireFrame = {
		message: {
			role: 'assistant',
			content: '',
			tool_calls: [{ function: { name: 'read_file', arguments: { path: '/etc/hosts' } } }],
		},
	}

	it('surfaces a call with an id, a name and stringified arguments', async () => {
		const { provider } = harness([callFrame, DONE])
		const chunks = await drain(provider, { tools: TOOLS })

		const call = chunks.flatMap((c) => c.delta.toolCalls ?? [])[0]
		expect(call?.index).toBe(0)
		expect(call?.id).toBeTruthy()
		expect(call?.function?.name).toBe('read_file')
		// The runtime parses this string; an object here would be dropped.
		expect(call?.function?.arguments).toBe('{"path":"/etc/hosts"}')
	})

	it('closes each call as it arrives instead of at end-of-stream', async () => {
		const { provider } = harness([callFrame, DONE])
		const chunks = await drain(provider, { tools: TOOLS })

		const withCall = chunks.findIndex((c) => (c.delta.toolCalls ?? []).length > 0)
		const end = chunks[withCall]?.delta.toolCallEnd
		expect(end?.index).toBe(0)
		expect(end?.id).toBe(chunks[withCall]?.delta.toolCalls?.[0]?.id)
	})

	it('gives parallel calls distinct indices and distinct ids', async () => {
		const both: WireFrame = {
			message: {
				role: 'assistant',
				content: '',
				tool_calls: [
					{ function: { name: 'read_file', arguments: { path: 'a' } } },
					{ function: { name: 'read_file', arguments: { path: 'b' } } },
				],
			},
		}
		const { provider } = harness([both, DONE])
		const calls = (await drain(provider, { tools: TOOLS })).flatMap((c) => c.delta.toolCalls ?? [])

		expect(calls.map((c) => c.index)).toEqual([0, 1])
		expect(new Set(calls.map((c) => c.id)).size).toBe(2)
	})

	it('keeps counting across chunks, not within one', async () => {
		const { provider } = harness([callFrame, callFrame, DONE])
		const calls = (await drain(provider, { tools: TOOLS })).flatMap((c) => c.delta.toolCalls ?? [])
		expect(calls.map((c) => c.index)).toEqual([0, 1])
	})

	it('reports tool_calls as the finish reason when a call was made', async () => {
		const { provider } = harness([callFrame, DONE])
		const chunks = await drain(provider, { tools: TOOLS })
		expect(chunks.at(-1)?.finishReason).toBe('tool_calls')
	})

	it('still reports stop when no call was made', async () => {
		const { provider } = harness([DONE])
		expect((await drain(provider)).at(-1)?.finishReason).toBe('stop')
	})

	it('reports length when the model ran out of room', async () => {
		const { provider } = harness([{ ...DONE, done_reason: 'length' }])
		expect((await drain(provider)).at(-1)?.finishReason).toBe('length')
	})
})

describe('the turn that made the call, replayed', () => {
	const conversation: ChatCompletionParams['messages'] = [
		{ role: 'user', content: 'read it' },
		{
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id: 'call-1',
					type: 'function',
					function: { name: 'read_file', arguments: '{"path":"/etc/hosts"}' },
				},
			],
		},
		{ role: 'tool', toolCallId: 'call-1', content: '127.0.0.1 localhost' },
	]

	it('echoes the assistant call back with its arguments as an object', async () => {
		const { provider, bodies } = harness([DONE])
		await drain(provider, { messages: conversation, tools: TOOLS })

		const messages = bodies[0]?.messages as Record<string, unknown>[]
		const assistant = messages[1] as { tool_calls?: Array<{ function: unknown }> }
		expect(assistant.tool_calls).toHaveLength(1)
		expect(assistant.tool_calls?.[0]?.function).toEqual({
			name: 'read_file',
			arguments: { path: '/etc/hosts' },
		})
	})

	it('names the tool on the result, resolved from the call it answers', async () => {
		const { provider, bodies } = harness([DONE])
		await drain(provider, { messages: conversation, tools: TOOLS })

		const messages = bodies[0]?.messages as Record<string, unknown>[]
		expect(messages[2]?.role).toBe('tool')
		// The wire binds a result to its call by name; without this the
		// server has no way to tell which call was answered.
		expect(messages[2]?.tool_name).toBe('read_file')
	})

	it('survives arguments the model emitted malformed', async () => {
		const { provider, bodies } = harness([DONE])
		await drain(provider, {
			messages: [
				{
					role: 'assistant',
					content: null,
					toolCalls: [
						{ id: 'c', type: 'function', function: { name: 'read_file', arguments: '{"pa' } },
					],
				},
			],
			tools: TOOLS,
		})

		const messages = bodies[0]?.messages as Array<{ tool_calls?: Array<{ function: unknown }> }>
		// The call stays visible rather than vanishing: a result with no call
		// to answer is rejected on the wire.
		expect(messages[0]?.tool_calls?.[0]?.function).toEqual({ name: 'read_file', arguments: {} })
	})
})

describe('images', () => {
	const PNG = 'iVBORw0KGgo='

	it('sends a user attachment as image bytes, not as a text placeholder', async () => {
		const { provider, bodies } = harness([DONE])
		await drain(provider, {
			messages: [
				{
					role: 'user',
					content: 'what is this',
					attachments: [{ data: PNG, mediaType: 'image/png' }],
				},
			],
		})

		const messages = bodies[0]?.messages as Array<{ content: string; images?: string[] }>
		expect(messages[0]?.images).toEqual([PNG])
		expect(messages[0]?.content).toBe('what is this')
		expect(messages[0]?.content).not.toContain('not renderable')
	})

	it('names an undecodable format instead of sending bytes that fail the request', async () => {
		const { provider, bodies } = harness([DONE])
		await drain(provider, {
			messages: [
				{ role: 'user', content: 'look', attachments: [{ data: PNG, mediaType: 'image/tiff' }] },
			],
		})

		const messages = bodies[0]?.messages as Array<{ content: string; images?: string[] }>
		expect(messages[0]?.images).toBeUndefined()
		expect(messages[0]?.content).toContain('image/tiff')
		expect(messages[0]?.content).not.toContain(PNG)
	})

	it('carries an image out of a tool result and keeps a marker naming it', async () => {
		const { provider, bodies } = harness([DONE])
		await drain(provider, {
			messages: [
				{
					role: 'tool',
					toolCallId: 'c',
					content: [
						{ type: 'text', text: 'captured' },
						{ type: 'image', data: PNG, mediaType: 'image/png' },
					],
				},
			],
		})

		const messages = bodies[0]?.messages as Array<{ content: string; images?: string[] }>
		expect(messages[0]?.images).toEqual([PNG])
		expect(messages[0]?.content).toContain('captured')
		expect(messages[0]?.content).toContain('image/png')
		// The payload must never end up in the prompt as text.
		expect(messages[0]?.content).not.toContain(PNG)
	})
})

describe('reasoning', () => {
	it('asks for it only when the caller enabled it', async () => {
		const { provider, bodies } = harness([DONE])
		await drain(provider)
		expect(bodies[0]).not.toHaveProperty('think')

		const enabled = harness([DONE])
		await drain(enabled.provider, { thinking: { type: 'enabled' } })
		expect(enabled.bodies[0]?.think).toBe(true)
	})

	it('surfaces thinking as reasoning and closes the block when the answer starts', async () => {
		const { provider } = harness([
			{ message: { role: 'assistant', content: '', thinking: 'let me check' } },
			{ message: { role: 'assistant', content: 'the answer' } },
			DONE,
		])
		const chunks = await drain(provider, { thinking: { type: 'enabled' } })

		const reasoning = chunks.map((c) => c.delta.reasoning).filter((r) => r !== undefined)
		expect(reasoning[0]?.text).toBe('let me check')
		expect(reasoning.at(-1)?.done).toBe(true)

		const closeAt = chunks.findIndex((c) => c.delta.reasoning?.done === true)
		const contentAt = chunks.findIndex((c) => c.delta.content === 'the answer')
		// The block has to close before the answer, or the runtime files the
		// answer as part of the reasoning.
		expect(closeAt).toBeLessThan(contentAt)
	})

	it('closes an unterminated block at end-of-stream', async () => {
		const { provider } = harness([
			{ message: { role: 'assistant', content: '', thinking: 'thinking only' } },
			DONE,
		])
		const chunks = await drain(provider, { thinking: { type: 'enabled' } })
		expect(chunks.some((c) => c.delta.reasoning?.done === true)).toBe(true)
	})

	it('replays a stored reasoning block back to the model', async () => {
		const { provider, bodies } = harness([DONE])
		await drain(provider, {
			messages: [
				{
					role: 'assistant',
					content: 'done',
					reasoning: [{ type: 'thinking', text: 'because of X' }],
				},
			],
		})

		const messages = bodies[0]?.messages as Array<{ thinking?: string }>
		expect(messages[0]?.thinking).toBe('because of X')
	})
})
