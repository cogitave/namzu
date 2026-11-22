import type { ChatCompletionParams, TokenUsage } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { OpenAIProvider } from '../client.js'
import { CodexProvider } from '../codex.js'
import type { OpenAIConfig } from '../types.js'

/**
 * What fast mode puts on the wire, and what it reads back, on both transports.
 * Fakes only: nothing here reaches a network.
 */

function chatProvider(config: Partial<OpenAIConfig>, chunks: readonly Record<string, unknown>[]) {
	const provider = new OpenAIProvider({ apiKey: 'test-key', ...config })
	const create = vi.fn(async (_body: Record<string, unknown>, _options?: unknown) =>
		(async function* () {
			for (const chunk of chunks) yield chunk
		})(),
	)
	;(provider as unknown as { client: { chat: { completions: { create: unknown } } } }).client = {
		chat: { completions: { create } },
	}
	return { provider, create }
}

const usageChunk = (extra: Record<string, unknown> = {}) => ({
	id: 'c1',
	choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
	usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
	...extra,
})

async function chat(
	provider: OpenAIProvider,
	extra: Partial<ChatCompletionParams>,
): Promise<TokenUsage[]> {
	const usages: TokenUsage[] = []
	for await (const chunk of provider.chatStream({
		model: 'gpt-5.5',
		messages: [{ role: 'user', content: 'hi' }],
		...extra,
	} as ChatCompletionParams)) {
		if (chunk.usage) usages.push(chunk.usage)
	}
	return usages
}

describe('Chat Completions fast mode', () => {
	it('sends service_tier priority for fast, and nothing for standard or absent', async () => {
		const { provider, create } = chatProvider({}, [usageChunk()])
		await chat(provider, { speed: 'fast' })
		expect(create.mock.calls[0]?.[0]).toMatchObject({ service_tier: 'priority' })
		await chat(provider, { speed: 'standard' })
		await chat(provider, {})
		expect(create.mock.calls[1]?.[0]).not.toHaveProperty('service_tier')
		expect(create.mock.calls[2]?.[0]).not.toHaveProperty('service_tier')
	})

	it('refuses ultrafast, an unlisted model and a compatible endpoint before any request', async () => {
		const { provider, create } = chatProvider({}, [usageChunk()])
		await expect(chat(provider, { speed: 'ultrafast' })).rejects.toMatchObject({
			providerCode: 'fast_mode_unsupported',
		})
		await expect(chat(provider, { speed: 'fast', model: 'gpt-4o' })).rejects.toMatchObject({
			providerCode: 'fast_mode_unsupported',
		})
		const compatible = chatProvider({ baseURL: 'https://gw.example.com/v1' }, [usageChunk()])
		await expect(chat(compatible.provider, { speed: 'fast' })).rejects.toMatchObject({
			providerCode: 'fast_mode_unsupported',
		})
		expect(create).not.toHaveBeenCalled()
		expect(compatible.create).not.toHaveBeenCalled()
	})

	it('reads a priority echo as fast, never as a service tier', async () => {
		const { provider } = chatProvider({}, [usageChunk({ service_tier: 'priority' })])
		const [usage] = await chat(provider, { speed: 'fast' })
		expect(usage?.speed).toBe('fast')
		expect(usage).not.toHaveProperty('serviceTier')
	})

	it('reads a default echo as standard, and no echo as the speed asked for', async () => {
		const downgraded = chatProvider({}, [usageChunk({ service_tier: 'default' })])
		const [standard] = await chat(downgraded.provider, { speed: 'fast' })
		expect(standard).not.toHaveProperty('speed')
		const silent = chatProvider({}, [usageChunk()])
		const [asked] = await chat(silent.provider, { speed: 'fast' })
		expect(asked?.speed).toBe('fast')
	})

	it('carries a flex echo as the service tier', async () => {
		const { provider } = chatProvider({}, [usageChunk({ service_tier: 'flex' })])
		const [usage] = await chat(provider, {})
		expect(usage?.serviceTier).toBe('flex')
	})

	it('takes the echo from an earlier chunk when the usage chunk carries none', async () => {
		const { provider } = chatProvider({}, [
			{ id: 'c1', service_tier: 'priority', choices: [{ index: 0, delta: { content: 'a' } }] },
			usageChunk(),
		])
		const [usage] = await chat(provider, { speed: 'fast' })
		expect(usage?.speed).toBe('fast')
	})
})

// The listing is remembered per account for the life of the process, so each
// fixture provider gets an account of its own unless a test says otherwise.
let accountSeq = 0

function codexProvider(
	response: Record<string, unknown> = {},
	accountId = `fixture-${++accountSeq}`,
) {
	const provider = new CodexProvider({ accessToken: 'fixture', accountId })
	const create = vi.fn(async (_request: unknown, _options?: unknown) =>
		(async function* () {
			yield {
				type: 'response.completed',
				response: {
					id: 'r1',
					output: [],
					usage: { input_tokens: 3, output_tokens: 2 },
					...response,
				},
			}
		})(),
	)
	const get = vi.fn(async () => ({
		models: [
			{
				slug: 'gpt-6.2-sol',
				service_tiers: [
					{ id: 'priority', name: 'Fast', description: 'faster' },
					{ id: 'ultrafast', name: 'Ultrafast', description: 'fastest' },
				],
				additional_speed_tiers: ['fast', 'ultrafast'],
				default_service_tier: null,
			},
			{ slug: 'gpt-6-sol', additional_speed_tiers: ['fast'], default_service_tier: null },
			{ slug: 'gpt-5.6-luna' },
			{ slug: 'flexy', service_tiers: [{ id: 'flex' }] },
		],
	}))
	;(provider as unknown as { client: unknown }).client = {
		responses: { create },
		get,
	}
	return { provider, create, get }
}

async function codex(provider: CodexProvider, extra: Partial<ChatCompletionParams>) {
	const usages: TokenUsage[] = []
	for await (const chunk of provider.chatStream({
		model: 'gpt-6.2-sol',
		messages: [{ role: 'user', content: 'fixture' }],
		...extra,
	} as ChatCompletionParams)) {
		if (chunk.usage) usages.push(chunk.usage)
	}
	return usages
}

describe('Codex subscription fast mode', () => {
	it('reads the tiers from the listing, from either spelling, and none where the listing has none', async () => {
		const { provider } = codexProvider()
		expect(provider.speedTiersFor('gpt-6.2-sol')).toBeUndefined()
		const models = await provider.listModels()
		expect(Object.fromEntries(models.map((m) => [m.id, m.speedTiers]))).toEqual({
			'gpt-6.2-sol': ['fast', 'ultrafast'],
			'gpt-6-sol': ['fast'],
			'gpt-5.6-luna': [],
			flexy: [],
		})
		expect(provider.speedTiersFor('GPT-6.2-SOL')).toEqual(['fast', 'ultrafast'])
		expect(provider.speedTiersFor('not-listed')).toEqual([])
	})

	it('sends priority with the routing header for fast, and the literal for ultrafast', async () => {
		const { provider, create } = codexProvider()
		await provider.listModels()
		await codex(provider, { speed: 'fast' })
		expect(create.mock.calls[0]?.[0]).toMatchObject({ service_tier: 'priority' })
		expect(create.mock.calls[0]?.[1]).toMatchObject({
			headers: { 'x-codex-routing-hint': 'model=gpt-6.2-sol;tier=priority' },
		})
		await codex(provider, { speed: 'ultrafast' })
		expect(create.mock.calls[1]?.[0]).toMatchObject({ service_tier: 'ultrafast' })
		expect(create.mock.calls[1]?.[1]).toMatchObject({
			headers: { 'x-codex-routing-hint': 'model=gpt-6.2-sol;tier=ultrafast' },
		})
	})

	it('sends no field and no header for standard or absent', async () => {
		const { provider, create } = codexProvider()
		await provider.listModels()
		await codex(provider, { speed: 'standard' })
		await codex(provider, {})
		for (const call of create.mock.calls) {
			expect(call[0]).not.toHaveProperty('service_tier')
			expect(call[1]).not.toHaveProperty('headers')
		}
	})

	it('refuses a tier the listing does not offer, and any tier before the listing has answered', async () => {
		const { provider, create } = codexProvider()
		await expect(codex(provider, { speed: 'fast' })).rejects.toMatchObject({
			providerCode: 'fast_mode_unsupported',
		})
		await provider.listModels()
		await expect(codex(provider, { speed: 'ultrafast', model: 'gpt-6-sol' })).rejects.toMatchObject(
			{
				providerCode: 'fast_mode_unsupported',
			},
		)
		await expect(codex(provider, { speed: 'fast', model: 'gpt-5.6-luna' })).rejects.toMatchObject({
			providerCode: 'fast_mode_unsupported',
		})
		expect(create).not.toHaveBeenCalled()
	})

	it('reads the served tier from the completed response, and the requested one when it says none', async () => {
		const echoed = codexProvider({ service_tier: 'ultrafast' })
		await echoed.provider.listModels()
		const [ultra] = await codex(echoed.provider, { speed: 'fast' })
		expect(ultra?.speed).toBe('ultrafast')
		const silent = codexProvider()
		await silent.provider.listModels()
		const [asked] = await codex(silent.provider, { speed: 'fast' })
		expect(asked?.speed).toBe('fast')
		const downgraded = codexProvider({ service_tier: 'default' })
		await downgraded.provider.listModels()
		const [standard] = await codex(downgraded.provider, { speed: 'fast' })
		expect(standard).not.toHaveProperty('speed')
	})
})
it('keeps the listing across a rebuild around a refreshed token', async () => {
	const first = codexProvider({}, 'refreshed-account')
	await first.provider.listModels()
	const rebuilt = new CodexProvider({
		accessToken: 'newer',
		accountId: 'refreshed-account',
	})
	expect(rebuilt.speedTiersFor('gpt-6.2-sol')).toEqual(['fast', 'ultrafast'])
	const create = vi.fn(async () =>
		(async function* () {
			yield {
				type: 'response.completed',
				response: { id: 'r', output: [], usage: {} },
			}
		})(),
	)
	;(rebuilt as unknown as { client: unknown }).client = {
		responses: { create },
	}
	await codex(rebuilt, { speed: 'fast' })
	expect(create).toHaveBeenCalledTimes(1)
	const other = new CodexProvider({
		accessToken: 'x',
		accountId: 'another-account',
	})
	expect(other.speedTiersFor('gpt-6.2-sol')).toBeUndefined()
})
