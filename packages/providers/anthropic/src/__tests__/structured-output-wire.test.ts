import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ChatCompletionParams } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { AnthropicProvider } from '../client.js'

let server: Server | undefined
afterEach(async () => {
	if (server) {
		server.closeAllConnections()
		await new Promise<void>((resolve) => server?.close(() => resolve()))
		server = undefined
	}
})

async function endpoint() {
	const bodies: Record<string, unknown>[] = []
	server = createServer(async (request, response) => {
		const chunks: Buffer[] = []
		for await (const chunk of request) chunks.push(Buffer.from(chunk))
		bodies.push(JSON.parse(Buffer.concat(chunks).toString()))
		response.writeHead(200, { 'content-type': 'text/event-stream' })
		const events = [
			{
				type: 'message_start',
				message: {
					id: 'message-1',
					type: 'message',
					role: 'assistant',
					content: [],
					model: 'claude-sonnet-5',
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			},
			{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"score":2}' } },
			{ type: 'content_block_stop', index: 0 },
			{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
			{ type: 'message_stop' },
		]
		for (const event of events)
			response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
		response.end()
	})
	await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
	return {
		bodies,
		provider: new AnthropicProvider({
			apiKey: 'test-key',
			baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		}),
	}
}
const schema = {
	type: 'object',
	properties: { score: { type: 'number' } },
	required: ['score'],
	additionalProperties: false,
}
const base: ChatCompletionParams = {
	model: 'claude-sonnet-5',
	messages: [{ role: 'user', content: 'Return a score' }],
}

describe('native structured output reaches the real Anthropic HTTP transport', () => {
	it.each([undefined, 'low'] as const)(
		'preserves JSON schema alongside effort %s',
		async (effort) => {
			const { provider, bodies } = await endpoint()
			const output = []
			for await (const chunk of provider.chatStream({
				...base,
				effort,
				responseFormat: {
					type: 'json_schema',
					json_schema: { name: 'score', schema, strict: true },
				},
			}))
				output.push(chunk)
			expect(bodies).toHaveLength(1)
			expect(bodies[0]?.output_config).toEqual({
				...(effort ? { effort } : {}),
				format: { type: 'json_schema', schema },
			})
			expect(bodies[0]).not.toHaveProperty('response_format')
			expect(JSON.stringify(output)).toContain('score')
		},
	)
	it('does not add a format for ordinary text requests', async () => {
		const { provider, bodies } = await endpoint()
		for await (const _ of provider.chatStream({ ...base, effort: 'low' })) {
		}
		expect(bodies[0]?.output_config).toEqual({ effort: 'low' })
	})
	it.each([
		{ type: 'json_object' },
		{ type: 'json_schema', json_schema: { name: 'score', schema, strict: false } },
	] satisfies NonNullable<ChatCompletionParams['responseFormat']>[])(
		'refuses unsupported format semantics before sending a request: %j',
		async (responseFormat) => {
			const { provider, bodies } = await endpoint()
			await expect(
				(async () => {
					for await (const _ of provider.chatStream({ ...base, responseFormat })) {
					}
				})(),
			).rejects.toMatchObject({ kind: 'bad_request', providerId: 'anthropic' })
			expect(bodies).toHaveLength(0)
		},
	)
})
