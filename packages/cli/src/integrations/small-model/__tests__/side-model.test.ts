import type { LLMProvider, ModelInfo, SessionId, StreamChunk, TokenUsage, TurnId } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { type SideLedger, createSideModel } from '../side-model.js'

const sessionId = 'session-1' as SessionId
const turnId = 'turn-1' as TurnId
const usage: TokenUsage = {
	promptTokens: 40,
	completionTokens: 8,
	totalTokens: 48,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

const listed = (id: string, inputPrice: number, outputPrice: number): ModelInfo => ({
	id,
	name: id,
	inputPrice,
	outputPrice,
	supportsToolUse: true,
	supportsStreaming: true,
})

interface FakeProvider extends LLMProvider {
	readonly requests: {
		model: string
		system: string
		user: string
		maxTokens: number | undefined
	}[]
}

function fakeProvider(options: {
	reply?: string
	models?: readonly ModelInfo[] | Error
	failChat?: boolean
}): FakeProvider {
	const requests: FakeProvider['requests'] = []
	const provider = {
		id: 'acme',
		name: 'Acme',
		requests,
		async listModels() {
			if (options.models instanceof Error) throw options.models
			return [...(options.models ?? [])]
		},
		async *chatStream(params: {
			model: string
			messages: readonly { role: string; content: unknown }[]
			maxTokens?: number
		}): AsyncIterable<StreamChunk> {
			requests.push({
				model: params.model,
				system: String(params.messages[0]?.content),
				user: String(params.messages[1]?.content),
				maxTokens: params.maxTokens,
			})
			if (options.failChat) throw new Error('provider down')
			yield {
				id: 'r',
				delta: { content: options.reply ?? 'ok' },
			} as StreamChunk
			yield { id: 'r', delta: {}, finishReason: 'stop', usage } as StreamChunk
		},
	}
	return provider as unknown as FakeProvider
}

function fakeLedger(): SideLedger & {
	now: number
	later: { turnId: TurnId; usage: TokenUsage }[]
	decline: boolean
} {
	const ledger = {
		now: 0,
		later: [] as { turnId: TurnId; usage: TokenUsage }[],
		decline: false,
		async chargeNow<T>(input: Parameters<SideLedger['chargeNow']>[0]): Promise<T | undefined> {
			if (ledger.decline) return undefined
			ledger.now++
			return (await input.request()).value as T
		},
		chargeLater(input: Parameters<SideLedger['chargeLater']>[0]) {
			ledger.later.push({ turnId: input.turnId, usage: input.usage })
		},
	}
	return ledger as never
}

const baseRequest = {
	sessionId,
	turnId,
	instruction: 'name it',
	body: 'the message',
	maxTokens: 60,
	signal: new AbortController().signal,
} as const

describe('the side model route', () => {
	it('uses the model smallModel names, at the provider it names', async () => {
		const built: { providerId: string; model: string }[] = []
		const side = createSideModel({
			active: () => ({ providerId: 'zen', model: 'big' }),
			configured: 'acme/tiny',
			isKnownProvider: (id) => id === 'acme',
			buildProvider: async (_s, target) => {
				built.push(target)
				return fakeProvider({ reply: 'T' })
			},
			ledger: fakeLedger(),
		})

		const route = await side.route(sessionId, new AbortController().signal)

		expect(route).toEqual({
			providerId: 'acme',
			model: 'tiny',
			source: 'configured',
		})
	})

	it('without smallModel, takes the cheapest priced model the active provider lists', async () => {
		const side = createSideModel({
			active: () => ({ providerId: 'acme', model: 'big' }),
			isKnownProvider: () => true,
			buildProvider: async () =>
				fakeProvider({
					models: [listed('big', 10, 50), listed('tiny', 0.2, 1), listed('mid', 3, 15)],
				}),
			ledger: fakeLedger(),
		})

		expect(await side.route(sessionId, new AbortController().signal)).toEqual({
			providerId: 'acme',
			model: 'tiny',
			source: 'cheapest',
		})
	})

	it('falls back to the conversation model when no price can be determined', async () => {
		const side = createSideModel({
			active: () => ({ providerId: 'acme', model: 'big' }),
			isKnownProvider: () => true,
			buildProvider: async () =>
				fakeProvider({
					models: [{ ...listed('a', 1, 1), inputPrice: undefined } as ModelInfo],
				}),
			ledger: fakeLedger(),
		})

		expect(await side.route(sessionId, new AbortController().signal)).toEqual({
			providerId: 'acme',
			model: 'big',
			source: 'main',
		})
	})

	it('falls back to the conversation model when the listing fails', async () => {
		const side = createSideModel({
			active: () => ({ providerId: 'acme', model: 'big' }),
			isKnownProvider: () => true,
			buildProvider: async () => fakeProvider({ models: new Error('offline') }),
			ledger: fakeLedger(),
		})

		expect((await side.route(sessionId, new AbortController().signal)).source).toBe('main')
	})

	it('reads the listing once per conversation model', async () => {
		let listings = 0
		const side = createSideModel({
			active: () => ({ providerId: 'acme', model: 'big' }),
			isKnownProvider: () => true,
			buildProvider: async () => {
				const provider = fakeProvider({ models: [listed('tiny', 1, 1)] })
				const list = provider.listModels?.bind(provider)
				provider.listModels = async (signal?: AbortSignal) => {
					listings++
					return (list as (s?: AbortSignal) => Promise<ModelInfo[]>)(signal)
				}
				return provider
			},
			ledger: fakeLedger(),
		})
		const signal = new AbortController().signal

		await side.route(sessionId, signal)
		await side.route(sessionId, signal)

		expect(listings).toBe(1)
	})
})

describe('asking the side model', () => {
	function sideOn(provider: LLMProvider, ledger: SideLedger) {
		return createSideModel({
			active: () => ({ providerId: 'acme', model: 'big' }),
			configured: 'acme/tiny',
			isKnownProvider: () => true,
			buildProvider: async () => provider,
			ledger,
		})
	}

	it('runs the request on the small model with no tools and the given budget', async () => {
		const provider = fakeProvider({ reply: 'Build failure' })
		const ledger = fakeLedger()

		const text = await sideOn(provider, ledger).ask({
			...baseRequest,
			timing: 'in-turn',
		})

		expect(text).toBe('Build failure')
		expect(provider.requests).toEqual([
			{ model: 'tiny', system: 'name it', user: 'the message', maxTokens: 60 },
		])
	})

	it('in-turn: counts the request on the turn ledger before it is made', async () => {
		const ledger = fakeLedger()

		await sideOn(fakeProvider({ reply: 'x' }), ledger).ask({
			...baseRequest,
			timing: 'in-turn',
		})

		expect(ledger.now).toBe(1)
		expect(ledger.later).toHaveLength(0)
	})

	it('in-turn: makes no request when the ledger has no room for it', async () => {
		const provider = fakeProvider({ reply: 'x' })
		const ledger = fakeLedger()
		ledger.decline = true

		const text = await sideOn(provider, ledger).ask({
			...baseRequest,
			timing: 'in-turn',
		})

		expect(text).toBeUndefined()
		expect(provider.requests).toHaveLength(0)
	})

	it('beside-turn: counts the usage the provider reported once the request is done', async () => {
		const ledger = fakeLedger()

		await sideOn(fakeProvider({ reply: 'Title' }), ledger).ask({
			...baseRequest,
			timing: 'beside-turn',
		})

		expect(ledger.later).toEqual([{ turnId, usage }])
	})

	it('resolves undefined, and throws nothing, when the provider fails', async () => {
		const ledger = fakeLedger()

		const text = await sideOn(fakeProvider({ failChat: true }), ledger).ask({
			...baseRequest,
			timing: 'beside-turn',
		})

		expect(text).toBeUndefined()
		expect(ledger.later).toHaveLength(0)
	})

	it('resolves undefined when there is no provider for the small model', async () => {
		const side = createSideModel({
			active: () => ({ providerId: 'acme', model: 'big' }),
			configured: 'other/tiny',
			isKnownProvider: () => true,
			buildProvider: async () => {
				throw new Error('no credential for other')
			},
			ledger: fakeLedger(),
		})

		expect(await side.ask({ ...baseRequest, timing: 'in-turn' })).toBeUndefined()
	})

	it('resolves undefined for an empty reply', async () => {
		const text = await sideOn(fakeProvider({ reply: '   ' }), fakeLedger()).ask({
			...baseRequest,
			timing: 'beside-turn',
		})
		expect(text).toBeUndefined()
	})

	it('resolves undefined when already cancelled', async () => {
		const controller = new AbortController()
		controller.abort()
		const provider = fakeProvider({ reply: 'x' })

		const text = await sideOn(provider, fakeLedger()).ask({
			...baseRequest,
			signal: controller.signal,
			timing: 'in-turn',
		})

		expect(text).toBeUndefined()
		expect(provider.requests).toHaveLength(0)
	})
})
