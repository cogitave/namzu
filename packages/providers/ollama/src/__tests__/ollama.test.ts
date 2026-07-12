import { DuplicateProviderError, ProviderRegistry, isProviderRequestError } from '@namzu/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OLLAMA_CAPABILITIES, registerOllama } from '../index.js'

// ---------------------------------------------------------------------------
// Vendor mock. The `ollama` client is replaced so chat()/chatStream() can be
// driven without a running daemon. No chat()/chatStream() test existed before
// Phase B; @namzu/http's fetch-stub pattern is the structural reference.
// ---------------------------------------------------------------------------

const { chatMock, listMock } = vi.hoisted(() => ({
	chatMock: vi.fn(),
	listMock: vi.fn(),
}))

vi.mock('ollama', () => ({
	Ollama: vi.fn(() => ({ chat: chatMock, list: listMock })),
}))

// Imported after vi.mock so the client binds to the mocked constructor.
const { OllamaProvider } = await import('../client.js')

// Ensure a clean slate between tests. The sdk pre-registers 'mock' on import
// via its sideEffects whitelist; we only need to clear 'ollama' to make
// re-registration deterministic across tests.
beforeEach(() => {
	if (ProviderRegistry.isSupported('ollama')) {
		ProviderRegistry.unregister('ollama')
	}
})

describe('@namzu/ollama', () => {
	describe('registerOllama()', () => {
		it("adds 'ollama' to the ProviderRegistry", () => {
			expect(ProviderRegistry.isSupported('ollama')).toBe(false)
			registerOllama()
			expect(ProviderRegistry.isSupported('ollama')).toBe(true)
			expect(ProviderRegistry.listTypes()).toContain('ollama')
		})

		it('throws DuplicateProviderError when called twice without options', () => {
			registerOllama()
			expect(() => registerOllama()).toThrowError(DuplicateProviderError)
		})

		it('allows re-registration when { replace: true } is passed', () => {
			registerOllama()
			expect(() => registerOllama({ replace: true })).not.toThrow()
			expect(ProviderRegistry.isSupported('ollama')).toBe(true)
		})

		it('exposes capabilities through the registry after registration', () => {
			registerOllama()
			const caps = ProviderRegistry.getCapabilities('ollama')
			expect(caps).toEqual(OLLAMA_CAPABILITIES)
		})
	})

	describe('OLLAMA_CAPABILITIES', () => {
		it('declares the expected capability flags', () => {
			expect(OLLAMA_CAPABILITIES).toEqual({
				supportsTools: false,
				supportsStreaming: true,
				supportsFunctionCalling: false,
				// The non-streaming chat() path has no vendor signal path.
				supportsAbortSignal: false,
			})
		})
	})
})

// ---------------------------------------------------------------------------
// Phase B: error taxonomy + finishReason mapping + signal forwarding.
//
// Current-code invariants asserted (2026-07-12, ses_015 Phase B):
//   - client.ts hardcoded finishReason 'stop' and discarded done_reason;
//     mapDoneReason now maps 'length'→'length' and everything else→'stop'.
//   - chat()/chatStream() had no try/catch; vendor/transport errors now become
//     ProviderRequestError with a runtime-classifiable `kind`.
//   - Ollama's vendor ResponseError carries `status_code` (not exported → duck-typed).
//   - Node fetch connection failures (ECONNREFUSED) → kind 'network'.
//   - The non-streaming chat() cannot be aborted (supportsAbortSignal:false); the
//     streaming iterator's .abort() is wired to params.signal best-effort.
// ---------------------------------------------------------------------------

function chatResponse(overrides: Record<string, unknown> = {}) {
	return {
		model: 'llama3.2',
		created_at: new Date(),
		message: { role: 'assistant', content: 'hello' },
		done: true,
		done_reason: 'stop',
		prompt_eval_count: 3,
		eval_count: 5,
		...overrides,
	}
}

function makeAbortableStream(chunks: Record<string, unknown>[]) {
	return {
		abort: vi.fn(),
		async *[Symbol.asyncIterator]() {
			for (const c of chunks) yield c
		},
	}
}

async function collectStream<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = []
	for await (const x of iter) out.push(x)
	return out
}

describe('OllamaProvider.chat — finishReason mapping', () => {
	beforeEach(() => {
		chatMock.mockReset()
		listMock.mockReset()
	})

	it("maps done_reason 'stop' → finishReason 'stop'", async () => {
		chatMock.mockResolvedValueOnce(chatResponse({ done_reason: 'stop' }))
		const provider = new OllamaProvider({ model: 'llama3.2' })
		const resp = await provider.chat({
			model: 'llama3.2',
			messages: [{ role: 'user', content: 'hi' }],
		})
		expect(resp.finishReason).toBe('stop')
	})

	it("maps done_reason 'length' → finishReason 'length' (previously lost)", async () => {
		chatMock.mockResolvedValueOnce(chatResponse({ done_reason: 'length' }))
		const provider = new OllamaProvider({ model: 'llama3.2' })
		const resp = await provider.chat({
			model: 'llama3.2',
			messages: [{ role: 'user', content: 'hi' }],
		})
		expect(resp.finishReason).toBe('length')
	})

	it("maps an unknown/absent done_reason ('load') → 'stop'", async () => {
		chatMock.mockResolvedValueOnce(chatResponse({ done_reason: 'load' }))
		const provider = new OllamaProvider({ model: 'llama3.2' })
		const resp = await provider.chat({
			model: 'llama3.2',
			messages: [{ role: 'user', content: 'hi' }],
		})
		expect(resp.finishReason).toBe('stop')
	})

	it('carries content and usage through', async () => {
		chatMock.mockResolvedValueOnce(
			chatResponse({
				message: { role: 'assistant', content: 'answer' },
				prompt_eval_count: 8,
				eval_count: 4,
			}),
		)
		const provider = new OllamaProvider({ model: 'llama3.2' })
		const resp = await provider.chat({
			model: 'llama3.2',
			messages: [{ role: 'user', content: 'hi' }],
		})
		expect(resp.message.content).toBe('answer')
		expect(resp.usage.promptTokens).toBe(8)
		expect(resp.usage.completionTokens).toBe(4)
		expect(resp.usage.totalTokens).toBe(12)
	})
})

describe('OllamaProvider.chat — error taxonomy', () => {
	beforeEach(() => {
		chatMock.mockReset()
		listMock.mockReset()
	})

	it("maps a connection-refused TypeError → ProviderRequestError kind 'network'", async () => {
		const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
			code: 'ECONNREFUSED',
		})
		chatMock.mockRejectedValueOnce(new TypeError('fetch failed', { cause }))
		const provider = new OllamaProvider({ model: 'llama3.2' })

		await expect(
			provider.chat({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] }),
		).rejects.toMatchObject({ kind: 'network', providerId: 'ollama' })
	})

	it("maps a bare 'fetch failed' TypeError → kind 'network'", async () => {
		chatMock.mockRejectedValueOnce(new TypeError('fetch failed'))
		const provider = new OllamaProvider({ model: 'llama3.2' })
		await expect(
			provider.chat({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] }),
		).rejects.toMatchObject({ kind: 'network' })
	})

	it("maps vendor ResponseError status_code 429 → kind 'throttle' with status", async () => {
		chatMock.mockRejectedValueOnce(
			Object.assign(new Error('too many requests'), { status_code: 429 }),
		)
		const provider = new OllamaProvider({ model: 'llama3.2' })
		await expect(
			provider.chat({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] }),
		).rejects.toMatchObject({ kind: 'throttle', status: 429 })
	})

	it("maps vendor ResponseError status_code 500 → kind 'server'", async () => {
		chatMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { status_code: 500 }))
		const provider = new OllamaProvider({ model: 'llama3.2' })
		await expect(
			provider.chat({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] }),
		).rejects.toMatchObject({ kind: 'server', status: 500 })
	})

	it("maps vendor ResponseError status_code 400 → kind 'bad_request'", async () => {
		chatMock.mockRejectedValueOnce(Object.assign(new Error('bad'), { status_code: 400 }))
		const provider = new OllamaProvider({ model: 'llama3.2' })
		await expect(
			provider.chat({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] }),
		).rejects.toMatchObject({ kind: 'bad_request', status: 400 })
	})

	it('passes an already-normalized ProviderRequestError through unchanged', async () => {
		const { ProviderRequestError } = await import('@namzu/sdk')
		const original = new ProviderRequestError('preclassified', {
			kind: 'server',
			providerId: 'ollama',
		})
		chatMock.mockRejectedValueOnce(original)
		const provider = new OllamaProvider({ model: 'llama3.2' })
		await expect(
			provider.chat({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] }),
		).rejects.toBe(original)
	})

	it('produces errors that satisfy isProviderRequestError', async () => {
		chatMock.mockRejectedValueOnce(new TypeError('fetch failed'))
		const provider = new OllamaProvider({ model: 'llama3.2' })
		const err = await provider
			.chat({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] })
			.catch((e) => e)
		expect(isProviderRequestError(err)).toBe(true)
	})
})

describe('OllamaProvider — signal handling', () => {
	beforeEach(() => {
		chatMock.mockReset()
		listMock.mockReset()
	})

	it("chat() with an already-aborted signal throws kind 'aborted' without calling the vendor", async () => {
		const controller = new AbortController()
		controller.abort()
		const provider = new OllamaProvider({ model: 'llama3.2' })
		await expect(
			provider.chat({
				model: 'llama3.2',
				messages: [{ role: 'user', content: 'hi' }],
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ kind: 'aborted' })
		expect(chatMock).not.toHaveBeenCalled()
	})

	it('chatStream() forwards a later abort to the vendor iterator .abort()', async () => {
		const controller = new AbortController()
		const stream = makeAbortableStream([{ message: { content: 'a' }, done: false }])
		chatMock.mockResolvedValueOnce(stream)
		const provider = new OllamaProvider({ model: 'llama3.2' })

		const it = provider
			.chatStream({
				model: 'llama3.2',
				messages: [{ role: 'user', content: 'hi' }],
				signal: controller.signal,
			})
			[Symbol.asyncIterator]()

		// Open the stream + attach the abort listener, then abort.
		await it.next()
		expect(stream.abort).not.toHaveBeenCalled()
		controller.abort()
		expect(stream.abort).toHaveBeenCalledTimes(1)
	})

	it('chatStream() maps the final chunk done_reason → finishReason', async () => {
		const stream = makeAbortableStream([
			{ message: { content: 'hi' }, done: false },
			{
				message: { content: '' },
				done: true,
				done_reason: 'length',
				prompt_eval_count: 2,
				eval_count: 3,
			},
		])
		chatMock.mockResolvedValueOnce(stream)
		const provider = new OllamaProvider({ model: 'llama3.2' })

		const chunks = await collectStream(
			provider.chatStream({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] }),
		)
		const text = chunks.map((c) => c.delta.content ?? '').join('')
		expect(text).toBe('hi')
		const final = chunks.find((c) => c.finishReason !== undefined)
		expect(final?.finishReason).toBe('length')
	})

	it("chatStream() maps a stream-open connection failure → kind 'network'", async () => {
		chatMock.mockRejectedValueOnce(
			Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
		)
		const provider = new OllamaProvider({ model: 'llama3.2' })
		await expect(
			collectStream(
				provider.chatStream({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] }),
			),
		).rejects.toMatchObject({ kind: 'network' })
	})
})
