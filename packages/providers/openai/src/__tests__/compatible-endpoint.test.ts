import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { collectChatCompletion } from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'

import { OpenAIProvider } from '../client.js'

const servers: Server[] = []
afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.closeAllConnections()
					server.close((error) => (error ? reject(error) : resolve()))
				}),
		),
	)
})

async function endpoint(metadata: Record<string, unknown>, reasoningField = 'reasoning_content') {
	const server = createServer((req, res) => {
		req.resume()
		if (req.url === '/v1/models') {
			res.writeHead(200, { 'content-type': 'application/json' })
			res.end(JSON.stringify({ object: 'list', data: [{ id: 'compatible-model', ...metadata }] }))
			return
		}
		res.writeHead(200, { 'content-type': 'text/event-stream' })
		for (const delta of [{ [reasoningField]: 'A thought ' }, { [reasoningField]: 'cut short.' }]) {
			res.write(
				`data: ${JSON.stringify({ id: 'cut', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
			)
		}
		res.write(
			`data: ${JSON.stringify({ id: 'cut', choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 100, completion_tokens: 8192, total_tokens: 8292 } })}\n\n`,
		)
		res.end('data: [DONE]\n\n')
	})
	servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	return new OpenAIProvider({
		apiKey: 'fixture',
		baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
		maxRetries: 0,
	})
}

it('preserves the exact effort menu and token limits declared by a compatible endpoint', async () => {
	const provider = await endpoint({
		context_window_tokens: 1_048_576,
		maximum_output_tokens: 131_072,
		supported_reasoning_efforts: ['low', 'high', 'max'],
		reasoning_effort: 'max',
	})
	expect(await provider.listModels()).toEqual([
		expect.objectContaining({
			id: 'compatible-model',
			contextWindow: 1_048_576,
			maxOutputTokens: 131_072,
			reasoningEffortLevels: ['low', 'high', 'max'],
			reasoningEffortDefault: 'max',
		}),
	])
})

it.each([
	{},
	{
		context_window_tokens: 0,
		maximum_output_tokens: -1,
		supported_reasoning_efforts: ['high', 'unknown'],
		reasoning_effort: 'high',
	},
	{ supported_reasoning_efforts: ['high', 'high'], reasoning_effort: 'high' },
])('keeps absent or malformed compatible-endpoint declarations unknown: %j', async (metadata) => {
	const provider = await endpoint(metadata)
	const [model] = await provider.listModels()
	for (const key of [
		'contextWindow',
		'maxOutputTokens',
		'reasoningEffortLevels',
		'reasoningEffortDefault',
	])
		expect(model).not.toHaveProperty(key)
})

it.each(['reasoning_content', 'reasoning'])(
	'preserves a reasoning-only cutoff carried in %s through the real HTTP client',
	async (field) => {
		const provider = await endpoint({}, field)
		const response = await collectChatCompletion(
			provider.chatStream({
				model: 'compatible-model',
				messages: [{ role: 'user', content: 'Hi' }],
			}),
		)
		expect(response.finishReason).toBe('length')
		expect(response.message.content).toBeNull()
		expect(response.message.reasoning).toEqual([{ type: 'thinking', text: 'A thought cut short.' }])
		expect(response.usage.completionTokens).toBe(8192)
	},
)
