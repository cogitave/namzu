/**
 * Provider error taxonomy — LM Studio driver.
 *
 * `mapStopReason` folds `contextLengthReached` into `finishReason: 'length'`
 * unconditionally. When the prediction produced NO content, that is not a
 * truncated answer the runtime can auto-continue — the prompt itself did not
 * fit, and the turn failed. Today the caller receives a terminal chunk with
 * `finishReason: 'length'`, empty content, and no error at all: the run reads
 * as a successful (if empty) turn.
 *
 * Transport seam: `LMStudioConfig` exposes no injection point (the SDK owns a
 * websocket), so these tests substitute the driver's private `clientInstance`
 * with a stub prediction — the exact surface the mapping code reads.
 *
 * That substitution only works because the driver now builds its client on FIRST
 * USE rather than in the constructor. It used to connect immediately, so the
 * replacement landed after a socket had already been opened to an LM Studio that
 * is usually not running, and the connection failure surfaced as an unhandled
 * rejection that failed the suite while every assertion passed.
 */

import type { StreamChunk } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'
import { LMStudioProvider } from '../client.js'

const clientConstructor = vi.hoisted(() => vi.fn())

vi.mock('@lmstudio/sdk', () => ({
	LMStudioClient: class {
		readonly llm = {
			listLoaded: async () => [],
		}

		constructor(config: unknown) {
			clientConstructor(config)
		}
	},
}))

interface FakeStats {
	stopReason: string
	promptTokensCount?: number
	predictedTokensCount?: number
	totalTokensCount?: number
}

/**
 * The SDK's prediction handle is both async-iterable (fragments) and
 * awaitable (final result) — the driver uses both.
 */
function fakePrediction(fragments: string[], stats: FakeStats): AsyncIterable<{ content: string }> {
	// A REAL promise (so the driver's `await prediction` resolves to the final
	// result) with an async iterator bolted on (so `for await` walks the
	// fragments) — rather than a hand-rolled thenable, which is both less
	// faithful and trips biome's `noThenProperty`.
	const handle = Promise.resolve({ stats })
	Object.defineProperty(handle, Symbol.asyncIterator, {
		value: async function* () {
			for (const content of fragments) yield { content }
		},
	})
	return handle as unknown as AsyncIterable<{ content: string }>
}

function providerYielding(fragments: string[], stats: FakeStats): LMStudioProvider {
	const provider = new LMStudioProvider({ model: 'qwen3-8b' })
	;(provider as unknown as { clientInstance: unknown }).clientInstance = {
		llm: {
			model: async () => ({ respond: () => fakePrediction(fragments, stats) }),
		},
	}
	return provider
}

async function collectChunks(provider: LMStudioProvider): Promise<StreamChunk[]> {
	const out: StreamChunk[] = []
	for await (const chunk of provider.chatStream({
		model: 'qwen3-8b',
		messages: [{ role: 'user', content: 'a very long prompt' }],
	})) {
		out.push(chunk)
	}
	return out
}

async function captureChatStreamError(
	provider: LMStudioProvider,
	signal?: AbortSignal,
): Promise<unknown> {
	try {
		for await (const _chunk of provider.chatStream({
			model: 'qwen3-8b',
			messages: [{ role: 'user', content: 'a very long prompt' }],
			signal,
		})) {
			// drain
		}
	} catch (err) {
		return err
	}
	throw new Error('expected chatStream to throw')
}

describe('@namzu/lmstudio — context overflow is a failure, not a finish reason', () => {
	it("`contextLengthReached` with NO content throws a 'context_overflow' classified error", async () => {
		const provider = providerYielding([], {
			stopReason: 'contextLengthReached',
			promptTokensCount: 200_000,
			predictedTokensCount: 0,
		})

		const err = await captureChatStreamError(provider)

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'context_overflow',
			providerId: 'lmstudio',
		})
	})

	it("`contextLengthReached` AFTER content stays a 'length' finish so the runtime can auto-continue", async () => {
		const provider = providerYielding(['Once upon a time'], {
			stopReason: 'contextLengthReached',
			promptTokensCount: 100,
			predictedTokensCount: 4,
		})

		const chunks = await collectChunks(provider)

		expect(chunks.at(-1)?.finishReason).toBe('length')
	})
})

describe('@namzu/lmstudio — connection lifecycle and provider taxonomy', () => {
	it('constructs no websocket client until first use, then reuses one normalized client', async () => {
		clientConstructor.mockClear()
		const provider = new LMStudioProvider({
			host: 'https://lmstudio.example.test:1234',
			model: 'qwen3-8b',
		})

		expect(clientConstructor).not.toHaveBeenCalled()

		await provider.listModels()
		await provider.listModels()

		expect(clientConstructor).toHaveBeenCalledTimes(1)
		expect(clientConstructor).toHaveBeenCalledWith({
			baseUrl: 'wss://lmstudio.example.test:1234',
		})
	})

	it('classifies and sanitizes a raw client failure', async () => {
		const secret = 'lmstudio-secret-FAKE-DO-NOT-LOG'
		const provider = new LMStudioProvider({ model: 'qwen3-8b' })
		;(provider as unknown as { clientInstance: unknown }).clientInstance = {
			llm: {
				model: async () => Promise.reject(new Error(`websocket failed for ${secret}`)),
			},
		}

		const err = await captureChatStreamError(provider)

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'network',
			providerId: 'lmstudio',
		})
		expect((err as Error).message).not.toContain(secret)
		expect('cause' in (err as object)).toBe(false)
	})

	it('returns the caller abort reason while model resolution is still pending', async () => {
		const controller = new AbortController()
		const reason = new Error('user stopped')
		let rejectModel: ((error: unknown) => void) | undefined
		const modelPromise = new Promise<never>((_resolve, reject) => {
			rejectModel = reject
		})
		const model = vi.fn(async () => modelPromise)
		const provider = new LMStudioProvider({ model: 'qwen3-8b' })
		;(provider as unknown as { clientInstance: unknown }).clientInstance = {
			llm: {
				model,
			},
		}

		const pending = captureChatStreamError(provider, controller.signal)
		await Promise.resolve()
		expect(model).toHaveBeenCalledOnce()
		controller.abort(reason)
		const err = await pending

		expect(err).toBe(reason)

		// A non-abort vendor error settling after Stop must be owned by the race,
		// not become an unhandled rejection or replace the caller reason.
		rejectModel?.(new Error('late websocket failure'))
		await Promise.resolve()
	})
})
