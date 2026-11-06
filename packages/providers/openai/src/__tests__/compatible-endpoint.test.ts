import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { collectChatCompletion } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

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

it('reports the window a compatible endpoint declares, in any of the spellings catalogues use', async () => {
	for (const field of [
		'context_window',
		'context_length',
		'max_model_len',
		'context_window_tokens',
	]) {
		const provider = await endpoint({ [field]: 1_000_000, max_output_tokens: 384_000 })
		expect(await provider.resolveContextWindow('compatible-model')).toBe(1_000_000)
		const [model] = await provider.listModels()
		expect(model?.maxOutputTokens).toBe(384_000)
	}
})

it('leaves the answer to the SDK table when the endpoint declares nothing for the model', async () => {
	const provider = await endpoint({})
	expect(await provider.resolveContextWindow('compatible-model')).toBeUndefined()
	expect(await provider.resolveContextWindow('another-model')).toBeUndefined()
})

it('asks for the listing once, and not again for a while after one that failed', async () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		let listings = 0
		const server = createServer((req, res) => {
			req.resume()
			listings++
			if (listings === 1) {
				res.writeHead(500).end('{}')
				return
			}
			res.writeHead(200, { 'content-type': 'application/json' })
			res.end(
				JSON.stringify({
					object: 'list',
					data: [{ id: 'compatible-model', context_window: 262_144 }],
				}),
			)
		})
		servers.push(server)
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
		const provider = new OpenAIProvider({
			apiKey: 'fixture',
			baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
			maxRetries: 0,
		})
		// A failure is not an error, and it is not asked about again at the start of every turn.
		expect(await provider.resolveContextWindow('compatible-model')).toBeUndefined()
		expect(await provider.resolveContextWindow('compatible-model')).toBeUndefined()
		expect(listings).toBe(1)
		vi.advanceTimersByTime(5 * 60_000 + 1)
		expect(await provider.resolveContextWindow('compatible-model')).toBe(262_144)
		expect(await provider.resolveContextWindow('compatible-model')).toBe(262_144)
		expect(listings).toBe(2)
	} finally {
		vi.useRealTimers()
	}
})

it('cuts a listing that never answers short, and leaves the window to the table', async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	try {
		const server = createServer((req) => {
			req.resume() // never answered
		})
		servers.push(server)
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
		const provider = new OpenAIProvider({
			apiKey: 'fixture',
			baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
			maxRetries: 0,
		})
		const pending = provider.resolveContextWindow('compatible-model')
		await vi.advanceTimersByTimeAsync(3_001)
		expect(await pending).toBeUndefined()
	} finally {
		vi.useRealTimers()
	}
})

it('honours the caller’s own cancellation rather than treating it as a failed listing', async () => {
	const server = createServer((req) => {
		req.resume() // never answered
	})
	servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const provider = new OpenAIProvider({
		apiKey: 'fixture',
		baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
		maxRetries: 0,
	})
	const controller = new AbortController()
	const pending = provider.resolveContextWindow('compatible-model', controller.signal)
	controller.abort()
	await expect(pending).rejects.toThrow()
})

it('does not ask OpenAI’s own API, which declares no window, however the address is given', async () => {
	for (const baseURL of [undefined, 'https://api.openai.com/v1']) {
		const provider = new OpenAIProvider({ apiKey: 'fixture', ...(baseURL ? { baseURL } : {}) })
		const listing = vi.spyOn(provider, 'listModels')
		expect(await provider.resolveContextWindow('gpt-5')).toBeUndefined()
		expect(listing).not.toHaveBeenCalled()
	}
})

it('asks a gateway named by the standard base-URL variable', async () => {
	const server = createServer((req, res) => {
		req.resume()
		res.writeHead(200, { 'content-type': 'application/json' })
		res.end(JSON.stringify({ object: 'list', data: [{ id: 'm', context_length: 300_000 }] }))
	})
	servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	vi.stubEnv('OPENAI_BASE_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`)
	try {
		const provider = new OpenAIProvider({ apiKey: 'fixture', maxRetries: 0 })
		expect(await provider.resolveContextWindow('m')).toBe(300_000)
	} finally {
		vi.unstubAllEnvs()
	}
})

it('reads the other things a catalogue row states outright', async () => {
	const provider = await endpoint({
		context_length: 131_072,
		top_provider: { max_completion_tokens: 8_192 },
		architecture: { input_modalities: ['text', 'image', 'audio'] },
		pricing: { prompt: '0.0000003', completion: '0.0000012' },
		capabilities: {
			tools: false,
			reasoning_effort: true,
			reasoning_effort_values: ['low', 'high'],
			reasoning_effort_aliases: { medium: 'high', minimal: 'low' },
		},
	})
	const [model] = await provider.listModels()
	expect(model).toMatchObject({
		contextWindow: 131_072,
		maxOutputTokens: 8_192,
		inputModalities: ['text', 'image'],
		inputPrice: 0.3,
		outputPrice: 1.2,
		supportsToolUse: false,
		// The values it lists and the names it maps onto them are all accepted.
		reasoningEffortLevels: ['low', 'high', 'medium', 'minimal'],
	})
})

it('reads an explicit vision flag over a modality list, and an explicit no-effort flag as an empty menu', async () => {
	const [seeing] = await (
		await endpoint({ modalities: ['text'], capabilities: { vision: true } })
	).listModels()
	expect(seeing?.inputModalities).toEqual(['text', 'image'])
	const [blind] = await (await endpoint({ capabilities: { vision: false } })).listModels()
	expect(blind?.inputModalities).toEqual(['text'])
	const [plain] = await (await endpoint({ modalities: ['text', 'image'] })).listModels()
	expect(plain?.inputModalities).toEqual(['text', 'image'])
	// A modality list on a non-chat task may name outputs, so it says nothing about input.
	const [other] = await (await endpoint({ task: 'image', modalities: ['image'] })).listModels()
	expect(other).not.toHaveProperty('inputModalities')
	const [none] = await (await endpoint({ capabilities: { reasoning_effort: false } })).listModels()
	expect(none?.reasoningEffortLevels).toEqual([])
	// An unlisted menu (null) stays unknown even when aliases are given.
	const [unknown] = await (
		await endpoint({
			capabilities: {
				reasoning_effort: true,
				reasoning_effort_values: null,
				reasoning_effort_aliases: { medium: 'high' },
			},
		})
	).listModels()
	expect(unknown).not.toHaveProperty('reasoningEffortLevels')
})

it('does not read a price that is not in dollars, or a listing with a tools flag that is not false', async () => {
	const [credits] = await (
		await endpoint({ pricing: { prompt: '0.000001', completion: '0.000002', currency: 'CR' } })
	).listModels()
	expect(credits).not.toHaveProperty('inputPrice')
	expect(credits).not.toHaveProperty('outputPrice')
	const [free] = await (
		await endpoint({ pricing: { prompt: '0', completion: '0', currency: 'usd' } })
	).listModels()
	expect(free).toMatchObject({ inputPrice: 0, outputPrice: 0, supportsToolUse: true })
	const [silent] = await (await endpoint({ capabilities: { tools: 'maybe' } })).listModels()
	expect(silent?.supportsToolUse).toBe(true)
})

it('reads a gateway row that spells its limits its own way, and invents nothing it does not state', async () => {
	// A row as a hosted gateway sends it: the window is `context_length`; the output figure is a default,
	// not a maximum; prices are in the gateway's own credits; the effort menu is not listed.
	const provider = await endpoint({
		object: 'model',
		owned_by: 'gateway',
		task: 'chat',
		modalities: ['text'],
		pricing: { prompt_token_price: 0, completion_token_price: 0, currency: 'CR' },
		context_length: 524_288,
		default_max_output_tokens: 16_384,
		capabilities: {
			tools: true,
			thinking: true,
			reasoning_effort: true,
			reasoning_effort_values: null,
			reasoning_effort_aliases: { medium: 'high', minimal: 'low' },
			vision: false,
		},
	})
	expect(await provider.resolveContextWindow('compatible-model')).toBe(524_288)
	const [model] = await provider.listModels()
	expect(model).toMatchObject({ id: 'compatible-model', contextWindow: 524_288 })
	// A default is not a limit, credits are not dollars and an unlisted menu is unknown.
	for (const key of [
		'maxOutputTokens',
		'inputPrice',
		'outputPrice',
		'reasoningEffortLevels',
		'reasoningEffortDefault',
	])
		expect(model).not.toHaveProperty(key)
})
