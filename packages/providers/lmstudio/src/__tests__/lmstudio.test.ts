import { DuplicateProviderError, ProviderRegistry, isProviderRequestError } from '@namzu/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LMSTUDIO_CAPABILITIES, registerLMStudio } from '../index.js'

// ---------------------------------------------------------------------------
// Vendor mock. `@lmstudio/sdk` is replaced so chat()/chatStream() can be driven
// without a running LM Studio server. No chat()/chatStream() test existed before
// Phase B; @namzu/http's stub pattern is the structural reference.
// ---------------------------------------------------------------------------

const { modelMock, respondMock, listLoadedMock } = vi.hoisted(() => ({
	modelMock: vi.fn(),
	respondMock: vi.fn(),
	listLoadedMock: vi.fn(),
}))

vi.mock('@lmstudio/sdk', () => ({
	LMStudioClient: vi.fn(() => ({
		llm: { model: modelMock, listLoaded: listLoadedMock },
	})),
}))

// Imported after vi.mock so the client binds to the mocked constructor.
const { LMStudioProvider } = await import('../client.js')

// Ensure a clean slate between tests. The sdk pre-registers 'mock' on import
// via its sideEffects whitelist; we only need to clear 'lmstudio' to make
// re-registration deterministic across tests.
beforeEach(() => {
	if (ProviderRegistry.isSupported('lmstudio')) {
		ProviderRegistry.unregister('lmstudio')
	}
})

describe('@namzu/lmstudio', () => {
	describe('registerLMStudio()', () => {
		it("adds 'lmstudio' to the ProviderRegistry", () => {
			expect(ProviderRegistry.isSupported('lmstudio')).toBe(false)
			registerLMStudio()
			expect(ProviderRegistry.isSupported('lmstudio')).toBe(true)
			expect(ProviderRegistry.listTypes()).toContain('lmstudio')
		})

		it('throws DuplicateProviderError when called twice without options', () => {
			registerLMStudio()
			expect(() => registerLMStudio()).toThrowError(DuplicateProviderError)
		})

		it('allows re-registration when { replace: true } is passed', () => {
			registerLMStudio()
			expect(() => registerLMStudio({ replace: true })).not.toThrow()
			expect(ProviderRegistry.isSupported('lmstudio')).toBe(true)
		})

		it('exposes capabilities through the registry after registration', () => {
			registerLMStudio()
			const caps = ProviderRegistry.getCapabilities('lmstudio')
			expect(caps).toEqual(LMSTUDIO_CAPABILITIES)
		})
	})

	describe('LMSTUDIO_CAPABILITIES', () => {
		it('declares the expected capability flags', () => {
			expect(LMSTUDIO_CAPABILITIES).toEqual({
				supportsTools: true,
				supportsStreaming: true,
				supportsFunctionCalling: true,
				// model() and respond() both accept an AbortSignal.
				supportsAbortSignal: true,
			})
		})
	})
})

// ---------------------------------------------------------------------------
// Phase B: error taxonomy + context-overflow detection + signal forwarding.
//
// Current-code invariants asserted (2026-07-12, ses_015 Phase B):
//   - chat()/chatStream() had zero error handling; vendor/transport errors now
//     become ProviderRequestError with a runtime-classifiable `kind`.
//   - LM Studio reports context exhaustion as a SUCCESS with stopReason
//     'contextLengthReached'; empty content → throw kind 'context_overflow',
//     non-empty content → finishReason 'length' flows through.
//   - The WebSocket transport exposes no HTTP status; connection failures
//     (ECONNREFUSED / "Failed to connect to LM Studio") → kind 'network'.
//   - model() and respond() both accept params.signal (supportsAbortSignal:true).
// ---------------------------------------------------------------------------

type Fragment = { content?: string }
type Stats = {
	stopReason?: string
	promptTokensCount?: number
	predictedTokensCount?: number
	totalTokensCount?: number
}
type PredictionResult = { content?: string; stats: Stats }

/**
 * An `OngoingPrediction` is both async-iterable (streaming fragments) and
 * awaitable (resolving to the final result). This double-shape mock covers both.
 */
function makePrediction(fragments: Fragment[], result: PredictionResult) {
	return {
		async *[Symbol.asyncIterator]() {
			for (const f of fragments) yield f
		},
		// biome-ignore lint/suspicious/noThenProperty: OngoingPrediction is genuinely a thenable; the mock must mirror `await prediction`.
		then<TResult1 = PredictionResult, TResult2 = never>(
			onFulfilled?: ((value: PredictionResult) => TResult1 | PromiseLike<TResult1>) | null,
			onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
		): PromiseLike<TResult1 | TResult2> {
			return Promise.resolve(result).then(onFulfilled, onRejected)
		},
	}
}

async function collectStream<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = []
	for await (const x of iter) out.push(x)
	return out
}

describe('LMStudioProvider.chat — finishReason + context overflow', () => {
	beforeEach(() => {
		modelMock.mockReset()
		respondMock.mockReset()
		modelMock.mockResolvedValue({ respond: respondMock })
	})

	it("maps stopReason 'eosFound' → 'stop' and carries content + usage", async () => {
		respondMock.mockReturnValue(
			makePrediction([], {
				content: 'hello',
				stats: {
					stopReason: 'eosFound',
					promptTokensCount: 8,
					predictedTokensCount: 4,
					totalTokensCount: 12,
				},
			}),
		)
		const provider = new LMStudioProvider({ model: 'm' })
		const resp = await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
		expect(resp.finishReason).toBe('stop')
		expect(resp.message.content).toBe('hello')
		expect(resp.usage.promptTokens).toBe(8)
		expect(resp.usage.completionTokens).toBe(4)
		expect(resp.usage.totalTokens).toBe(12)
	})

	it("maps stopReason 'maxPredictedTokensReached' → 'length'", async () => {
		respondMock.mockReturnValue(
			makePrediction([], {
				content: 'partial',
				stats: { stopReason: 'maxPredictedTokensReached' },
			}),
		)
		const provider = new LMStudioProvider({ model: 'm' })
		const resp = await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
		expect(resp.finishReason).toBe('length')
	})

	it("contextLengthReached with EMPTY content → throws kind 'context_overflow'", async () => {
		respondMock.mockReturnValue(
			makePrediction([], {
				content: '',
				stats: {
					stopReason: 'contextLengthReached',
					promptTokensCount: 9000,
					predictedTokensCount: 0,
				},
			}),
		)
		const provider = new LMStudioProvider({ model: 'm' })
		await expect(
			provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
		).rejects.toMatchObject({ kind: 'context_overflow', providerId: 'lmstudio' })
	})

	it("contextLengthReached with NON-EMPTY content → finishReason 'length' flows through", async () => {
		respondMock.mockReturnValue(
			makePrediction([], {
				content: 'a partial answer before running out of room',
				stats: { stopReason: 'contextLengthReached', predictedTokensCount: 10 },
			}),
		)
		const provider = new LMStudioProvider({ model: 'm' })
		const resp = await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
		expect(resp.finishReason).toBe('length')
	})
})

describe('LMStudioProvider.chat — error taxonomy', () => {
	beforeEach(() => {
		modelMock.mockReset()
		respondMock.mockReset()
		modelMock.mockResolvedValue({ respond: respondMock })
	})

	it("maps a 'Failed to connect to LM Studio' error → kind 'network'", async () => {
		modelMock.mockRejectedValueOnce(new Error('Failed to connect to LM Studio.'))
		const provider = new LMStudioProvider({ model: 'm' })
		await expect(
			provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
		).rejects.toMatchObject({ kind: 'network', providerId: 'lmstudio' })
	})

	it("maps an ECONNREFUSED WebSocket error → kind 'network'", async () => {
		modelMock.mockRejectedValueOnce(
			Object.assign(new Error('WebSocket error'), { code: 'ECONNREFUSED' }),
		)
		const provider = new LMStudioProvider({ model: 'm' })
		await expect(
			provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
		).rejects.toMatchObject({ kind: 'network' })
	})

	it("maps an unrecognized error → kind 'unknown' (terminal, not retried)", async () => {
		respondMock.mockImplementationOnce(() => {
			throw new Error('model produced something weird')
		})
		const provider = new LMStudioProvider({ model: 'm' })
		await expect(
			provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
		).rejects.toMatchObject({ kind: 'unknown' })
	})

	it('passes an already-normalized ProviderRequestError through unchanged', async () => {
		const { ProviderRequestError } = await import('@namzu/sdk')
		const original = new ProviderRequestError('preclassified', {
			kind: 'server',
			providerId: 'lmstudio',
		})
		modelMock.mockRejectedValueOnce(original)
		const provider = new LMStudioProvider({ model: 'm' })
		await expect(
			provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
		).rejects.toBe(original)
	})

	it('produces errors that satisfy isProviderRequestError', async () => {
		modelMock.mockRejectedValueOnce(new Error('Failed to connect to LM Studio.'))
		const provider = new LMStudioProvider({ model: 'm' })
		const err = await provider
			.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
			.catch((e) => e)
		expect(isProviderRequestError(err)).toBe(true)
	})
})

describe('LMStudioProvider — signal handling', () => {
	beforeEach(() => {
		modelMock.mockReset()
		respondMock.mockReset()
		modelMock.mockResolvedValue({ respond: respondMock })
		respondMock.mockReturnValue(
			makePrediction([], { content: 'ok', stats: { stopReason: 'eosFound' } }),
		)
	})

	it("chat() with an already-aborted signal throws kind 'aborted' without loading the model", async () => {
		const controller = new AbortController()
		controller.abort()
		const provider = new LMStudioProvider({ model: 'm' })
		await expect(
			provider.chat({
				model: 'm',
				messages: [{ role: 'user', content: 'hi' }],
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ kind: 'aborted' })
		expect(modelMock).not.toHaveBeenCalled()
	})

	it('chat() forwards params.signal to both model() and respond()', async () => {
		const controller = new AbortController()
		const provider = new LMStudioProvider({ model: 'm' })
		await provider.chat({
			model: 'm',
			messages: [{ role: 'user', content: 'hi' }],
			signal: controller.signal,
		})
		expect(modelMock).toHaveBeenCalledWith('m', { signal: controller.signal })
		expect(respondMock).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal })
	})

	it('chat() omits opts entirely when no signal is provided', async () => {
		const provider = new LMStudioProvider({ model: 'm' })
		await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
		expect(modelMock).toHaveBeenCalledWith('m', undefined)
		expect(respondMock).toHaveBeenCalledWith(expect.anything(), undefined)
	})
})

describe('LMStudioProvider.chatStream', () => {
	beforeEach(() => {
		modelMock.mockReset()
		respondMock.mockReset()
		modelMock.mockResolvedValue({ respond: respondMock })
	})

	it('accumulates fragments and emits a final finishReason chunk', async () => {
		respondMock.mockReturnValue(
			makePrediction([{ content: 'Hel' }, { content: 'lo' }], {
				content: 'Hello',
				stats: { stopReason: 'eosFound', predictedTokensCount: 2, promptTokensCount: 3 },
			}),
		)
		const provider = new LMStudioProvider({ model: 'm' })
		const chunks = await collectStream(
			provider.chatStream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
		)
		expect(chunks.map((c) => c.delta.content ?? '').join('')).toBe('Hello')
		const final = chunks.find((c) => c.finishReason !== undefined)
		expect(final?.finishReason).toBe('stop')
		expect(final?.usage?.totalTokens).toBe(5)
	})

	it("contextLengthReached with empty content → rejects kind 'context_overflow'", async () => {
		respondMock.mockReturnValue(
			makePrediction([], {
				content: '',
				stats: { stopReason: 'contextLengthReached', predictedTokensCount: 0 },
			}),
		)
		const provider = new LMStudioProvider({ model: 'm' })
		await expect(
			collectStream(
				provider.chatStream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
			),
		).rejects.toMatchObject({ kind: 'context_overflow' })
	})

	it("maps a stream-open connection failure → kind 'network'", async () => {
		modelMock.mockReset()
		modelMock.mockRejectedValueOnce(new Error('Failed to connect to LM Studio.'))
		const provider = new LMStudioProvider({ model: 'm' })
		await expect(
			collectStream(
				provider.chatStream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
			),
		).rejects.toMatchObject({ kind: 'network' })
	})
})
