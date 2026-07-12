import { DuplicateProviderError, ProviderRegistry, ProviderRequestError } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OPENROUTER_CAPABILITIES, OpenRouterProvider, registerOpenRouter } from '../index.js'

// Ensure a clean slate between tests. The sdk pre-registers 'mock' on import
// via its sideEffects whitelist; we only need to clear 'openrouter' to make
// re-registration deterministic across tests.
beforeEach(() => {
	if (ProviderRegistry.isSupported('openrouter')) {
		ProviderRegistry.unregister('openrouter')
	}
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('@namzu/openrouter', () => {
	describe('registerOpenRouter()', () => {
		it("adds 'openrouter' to the ProviderRegistry", () => {
			expect(ProviderRegistry.isSupported('openrouter')).toBe(false)
			registerOpenRouter()
			expect(ProviderRegistry.isSupported('openrouter')).toBe(true)
			expect(ProviderRegistry.listTypes()).toContain('openrouter')
		})

		it('throws DuplicateProviderError when called twice without options', () => {
			registerOpenRouter()
			expect(() => registerOpenRouter()).toThrowError(DuplicateProviderError)
		})

		it('allows re-registration when { replace: true } is passed', () => {
			registerOpenRouter()
			expect(() => registerOpenRouter({ replace: true })).not.toThrow()
			expect(ProviderRegistry.isSupported('openrouter')).toBe(true)
		})

		it('exposes capabilities through the registry after registration', () => {
			registerOpenRouter()
			const caps = ProviderRegistry.getCapabilities('openrouter')
			expect(caps).toEqual(OPENROUTER_CAPABILITIES)
		})
	})

	describe('OPENROUTER_CAPABILITIES', () => {
		it('declares the expected capability flags', () => {
			expect(OPENROUTER_CAPABILITIES).toEqual({
				supportsTools: true,
				supportsStreaming: true,
				supportsFunctionCalling: true,
				supportsAbortSignal: true,
			})
		})
	})

	describe('ProviderRegistry.create({ type: "openrouter", ... })', () => {
		it('narrows the config type via module augmentation and instantiates OpenRouterProvider', () => {
			registerOpenRouter()
			const { provider, capabilities } = ProviderRegistry.create({
				type: 'openrouter',
				apiKey: 'test-key',
				siteUrl: 'https://example.com',
				siteName: 'Test',
			})
			expect(provider).toBeInstanceOf(OpenRouterProvider)
			expect(capabilities).toEqual(OPENROUTER_CAPABILITIES)
		})
	})
})

// ---------------------------------------------------------------------------
// Transport error taxonomy + AbortSignal forwarding (ses_015 Phase B)
//
// Current-code invariants asserted (2026-07-12, ses_015 Phase B):
//  - OpenRouterProvider.chat() maps a non-2xx Response to ProviderRequestError
//    with a classified `kind` (throttle/server/auth/bad_request/context_overflow)
//    and the upstream `status` attached.
//  - 429 carries retryAfterMs derived from the `Retry-After` header.
//  - A 400 whose body contains `context_length_exceeded` is context_overflow;
//    a plain 400 is bad_request.
//  - A thrown fetch rejection maps: caller-signal / AbortError → 'aborted';
//    TimeoutError and TypeError('fetch failed') → 'network'.
//  - params.signal is composed with the internal timeout and forwarded on the
//    fetch options object (aborting the caller signal aborts the request).
// ---------------------------------------------------------------------------

function mockJsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function mockErrorResponse(
	body: string,
	status: number,
	headers: Record<string, string> = {},
): Response {
	return new Response(body, { status, headers })
}

describe('@namzu/openrouter — transport error taxonomy', () => {
	function newProvider(): OpenRouterProvider {
		return new OpenRouterProvider({ apiKey: 'k' })
	}

	async function chatExpectError(provider: OpenRouterProvider): Promise<ProviderRequestError> {
		try {
			await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
		} catch (err) {
			return err as ProviderRequestError
		}
		throw new Error('expected chat() to throw')
	}

	it('429 → kind "throttle" with status and retryAfterMs from Retry-After header', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					mockErrorResponse('{"error":"rate limited"}', 429, { 'retry-after': '3' }),
				),
		)
		const err = await chatExpectError(newProvider())
		expect(err).toBeInstanceOf(ProviderRequestError)
		expect(err.kind).toBe('throttle')
		expect(err.status).toBe(429)
		expect(err.retryAfterMs).toBe(3000)
		expect(err.providerId).toBe('openrouter')
	})

	it('500 → kind "server"', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockErrorResponse('boom', 500)))
		const err = await chatExpectError(newProvider())
		expect(err.kind).toBe('server')
		expect(err.status).toBe(500)
	})

	it('403 → kind "auth"', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockErrorResponse('forbidden', 403)))
		const err = await chatExpectError(newProvider())
		expect(err.kind).toBe('auth')
		expect(err.status).toBe(403)
	})

	it('400 with context_length_exceeded body → kind "context_overflow"', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					mockErrorResponse(
						'{"error":{"code":"context_length_exceeded","message":"maximum context length is 8192 tokens"}}',
						400,
					),
				),
		)
		const err = await chatExpectError(newProvider())
		expect(err.kind).toBe('context_overflow')
		expect(err.status).toBe(400)
	})

	it('plain 400 (no overflow marker) → kind "bad_request"', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockErrorResponse('bad params', 400)))
		const err = await chatExpectError(newProvider())
		expect(err.kind).toBe('bad_request')
		expect(err.status).toBe(400)
	})

	it('DOMException AbortError → kind "aborted"', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockRejectedValue(new DOMException('The operation was aborted', 'AbortError')),
		)
		const err = await chatExpectError(newProvider())
		expect(err.kind).toBe('aborted')
	})

	it('caller signal already aborted → kind "aborted" (takes precedence)', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('timeout', 'TimeoutError')))
		const controller = new AbortController()
		controller.abort()
		try {
			await newProvider().chat({
				model: 'm',
				messages: [{ role: 'user', content: 'hi' }],
				signal: controller.signal,
			})
			throw new Error('expected throw')
		} catch (e) {
			expect((e as ProviderRequestError).kind).toBe('aborted')
		}
	})

	it('DOMException TimeoutError → kind "network"', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError')),
		)
		const err = await chatExpectError(newProvider())
		expect(err.kind).toBe('network')
	})

	it('TypeError("fetch failed") → kind "network"', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
		const err = await chatExpectError(newProvider())
		expect(err.kind).toBe('network')
	})
})

describe('@namzu/openrouter — AbortSignal forwarding', () => {
	it('composes params.signal with the internal timeout and forwards it to fetch', async () => {
		let captured: AbortSignal | undefined
		const fetchMock = vi.fn().mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
			captured = init.signal
			return Promise.resolve(
				mockJsonResponse({
					id: 'x',
					model: 'm',
					choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
				}),
			)
		})
		vi.stubGlobal('fetch', fetchMock)

		const controller = new AbortController()
		await new OpenRouterProvider({ apiKey: 'k' }).chat({
			model: 'm',
			messages: [{ role: 'user', content: 'hi' }],
			signal: controller.signal,
		})

		expect(captured).toBeInstanceOf(AbortSignal)
		expect(captured?.aborted).toBe(false)
		controller.abort()
		expect(captured?.aborted).toBe(true)
	})
})
