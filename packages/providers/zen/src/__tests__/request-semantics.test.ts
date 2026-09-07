import { type ChatCompletionParams, EditTool, type StreamChunk } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZenProvider } from '../client.js'

const apiKey = 'fixture-secret-key'
const base: ChatCompletionParams = {
	model: 'claude-sonnet-4-5',
	messages: [{ role: 'user', content: 'Hello' }],
}

afterEach(() => vi.unstubAllGlobals())

function messagesFrames(error?: Record<string, unknown>): Response {
	const frames = [
		{
			type: 'message_start',
			message: {
				id: 'message-1',
				type: 'message',
				role: 'assistant',
				content: [],
				model: base.model,
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial reply' } },
		...(error
			? [{ type: 'error', error }]
			: [
					{ type: 'content_block_stop', index: 0 },
					{
						type: 'message_delta',
						delta: { stop_reason: 'end_turn', stop_sequence: null },
						usage: { output_tokens: 2 },
					},
					{ type: 'message_stop' },
				]),
	]
	return new Response(
		frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
		{ headers: { 'content-type': 'text/event-stream' } },
	)
}

async function drain(params: ChatCompletionParams): Promise<StreamChunk[]> {
	const chunks: StreamChunk[] = []
	for await (const chunk of new ZenProvider({ apiKey }).chatStream(params)) chunks.push(chunk)
	return chunks
}

describe('native option semantics at the HTTP boundary', () => {
	it.each([false, true])(
		'preserves production edit and optional read schemas on Responses with strict mode disabled (enforcement hint: %s)',
		async (enforced) => {
			const editSchema = EditTool.modelInputSchema
			if (!editSchema) throw new Error('Expected the production edit model schema')
			expect(EditTool.enforceModelInput).toBe(true)
			const readSchema = {
				type: 'object',
				properties: {
					path: { type: 'string' },
					offset: { type: 'integer' },
					limit: { type: 'integer' },
				},
				required: ['path'],
				additionalProperties: false,
			}
			const requiredSchema = {
				type: 'object',
				properties: { text: { type: 'string' } },
				required: ['text'],
				additionalProperties: false,
			}
			const transport = vi.fn<typeof fetch>(
				async () =>
					new Response(
						[
							{
								type: 'response.created',
								response: {
									id: 'tool-schema-response',
									model: 'muse-spark-1.3-contributor-free',
									created_at: 1,
								},
							},
							{
								type: 'response.completed',
								response: { usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } },
							},
						]
							.map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
							.join(''),
						{ headers: { 'content-type': 'text/event-stream' } },
					),
			)
			vi.stubGlobal('fetch', transport)
			for await (const _ of new ZenProvider().chatStream({
				model: 'muse-spark-1.3-contributor-free',
				messages: [{ role: 'user', content: 'Read the file.' }],
				tools: [
					{
						type: 'function',
						function: {
							name: EditTool.name,
							description: EditTool.description,
							parameters: editSchema,
						},
					},
					{
						type: 'function',
						function: { name: 'read', description: 'Read a file', parameters: readSchema },
					},
					{
						type: 'function',
						function: {
							name: 'required_tool',
							description: 'Requires text',
							parameters: requiredSchema,
						},
					},
				],
				...(enforced ? { enforceToolInputSchema: [EditTool.name, 'required_tool'] } : {}),
			})) {
			}
			expect(transport).toHaveBeenCalledOnce()
			const request = transport.mock.calls[0]
			if (!request) throw new Error('Expected a Responses HTTP request')
			expect(request[0]).toBe('https://opencode.ai/zen/v1/responses')
			expect(new Headers(request[1]?.headers).get('authorization')).toBe('Bearer public')
			const body = JSON.parse(String(request[1]?.body))
			expect(body.tools).toEqual([
				{
					type: 'function',
					name: EditTool.name,
					description: EditTool.description,
					parameters: editSchema,
					strict: false,
				},
				{
					type: 'function',
					name: 'read',
					description: 'Read a file',
					parameters: readSchema,
					strict: false,
				},
				{
					type: 'function',
					name: 'required_tool',
					description: 'Requires text',
					parameters: requiredSchema,
					strict: false,
				},
			])
		},
	)

	it.each([2048, undefined])(
		'keeps manual thinking inside the total maxTokens cap (budget %s)',
		async (budgetTokens) => {
			const bodies: Record<string, unknown>[] = []
			vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
				bodies.push(JSON.parse(String(init.body)))
				return messagesFrames()
			})
			const chunks = await drain({
				...base,
				maxTokens: 4096,
				thinking: { type: 'enabled', ...(budgetTokens !== undefined ? { budgetTokens } : {}) },
			})
			expect(chunks.at(-1)?.finishReason).toBe('stop')
			expect(bodies).toHaveLength(1)
			expect(bodies[0]).toMatchObject({
				max_tokens: 4096,
				thinking: { type: 'enabled', budget_tokens: budgetTokens ?? 1024 },
			})
		},
	)

	it.each<Partial<ChatCompletionParams>>([
		{ thinking: { type: 'enabled', budgetTokens: 2048 }, temperature: 0.2 },
		{ thinking: { type: 'adaptive' }, topP: 0.8 },
		{ temperature: 1.2 },
		{ temperature: 0.2, topP: 0.8 },
		{ responseFormat: { type: 'json_object' } },
		{ maxTokens: 1024, thinking: { type: 'enabled' } },
		{ maxTokens: 2048, thinking: { type: 'enabled', budgetTokens: 2048 } },
		{ model: 'claude-opus-5', thinking: { type: 'disabled' }, effort: 'max' },
		{ model: 'gpt-5.6-luna', stop: ['END'] },
		{ model: 'gpt-5.6-luna', frequencyPenalty: 1 },
		{ model: 'gpt-5.6-luna', presencePenalty: 1 },
		{ model: 'gpt-5.6-luna', effort: 'low', temperature: 0.2 },
	])('refuses settings the native adapter would discard before any POST: %j', async (extra) => {
		const fetch = vi.fn()
		vi.stubGlobal('fetch', fetch)
		await expect(drain({ ...base, ...extra })).rejects.toMatchObject({ kind: 'bad_request' })
		expect(fetch).not.toHaveBeenCalled()
	})
})

describe.each(['messages', 'chat'] as const)('%s mid-stream error classification', (protocol) => {
	it.each([
		['authentication_error', 'auth'],
		['overloaded_error', 'server'],
		['rate_limit_error', 'throttle'],
	])(
		'keeps %s classification without retaining credentials or raw envelopes',
		async (type, kind) => {
			const error = { type, message: `Service rejected ${apiKey}`, request: { private: apiKey } }
			vi.stubGlobal('fetch', async () =>
				protocol === 'messages'
					? messagesFrames(error)
					: new Response(
							[
								{
									id: 'chat-1',
									choices: [{ index: 0, delta: { content: 'Partial reply' }, finish_reason: null }],
								},
								{ error },
							]
								.map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
								.join(''),
							{ headers: { 'content-type': 'text/event-stream' } },
						),
			)
			const chunks: StreamChunk[] = []
			let caught: unknown
			try {
				for await (const chunk of new ZenProvider({ apiKey }).chatStream({
					...base,
					model: protocol === 'messages' ? base.model : 'glm-5.3-flash',
				}))
					chunks.push(chunk)
			} catch (error) {
				caught = error
			}
			expect(chunks.some((chunk) => chunk.delta.content === 'Partial reply')).toBe(true)
			expect(chunks.some((chunk) => chunk.finishReason !== undefined)).toBe(false)
			expect(caught).toMatchObject({
				kind,
				detail: 'Service rejected [REDACTED:api-key]',
			})
			expect(caught).toBeInstanceOf(Error)
			expect(JSON.stringify(caught)).not.toContain(apiKey)
			expect(caught).not.toHaveProperty('cause')
			expect(caught).not.toHaveProperty('request')
		},
	)
})
