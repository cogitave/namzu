import type { Message } from '@namzu/sdk'
import { type ProviderRequestError, isProviderRequestError } from '@namzu/sdk'
import { APIConnectionError, APIError, APIUserAbortError } from 'openai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAIProvider } from '../client.js'

// Current-code invariants asserted (2026-07-12, ses_015 Phase B):
// - chat() maps every vendor SDK error class onto the ProviderRequestError
//   taxonomy: 429→throttle (retryAfterMs from Retry-After or x-ratelimit-reset-*),
//   500→server, APIConnectionError→network, 401→auth, code
//   'context_length_exceeded' 400→context_overflow, plain 400→bad_request,
//   APIUserAbortError→aborted.
// - .create() receives { signal, maxRetries: 0 } as its second RequestOptions arg
//   so the vendor SDK performs no internal retries.
// - the serializer converts an interrupted history (assistant toolCalls with a
//   '{}'-arguments call + a synthesized '[SYSTEM] Tool result missing...' result)
//   to the OpenAI wire format without throwing.

// Mock only the vendor client (default export); keep the real error classes so
// the adapter's instanceof-based mapping matches the errors the tests throw.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }))

vi.mock('openai', async (importOriginal) => {
	const actual = await importOriginal<typeof import('openai')>()
	class MockOpenAI {
		chat = { completions: { create: createMock } }
		models = { list: vi.fn() }
	}
	return { ...actual, default: MockOpenAI }
})

const OK_RESPONSE = {
	id: 'chatcmpl-1',
	model: 'gpt-x',
	choices: [
		{ message: { role: 'assistant', content: 'hi', tool_calls: undefined }, finish_reason: 'stop' },
	],
	usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

function newProvider(): OpenAIProvider {
	return new OpenAIProvider({ apiKey: 'test-key', model: 'gpt-x' })
}

// OpenAI wraps the inner error object under `error` in the response body.
function openaiBody(fields: { message: string; type?: string; code?: string; param?: string }): {
	error: { message: string; type?: string; code?: string; param?: string }
} {
	return { error: fields }
}

beforeEach(() => {
	createMock.mockReset()
})

describe('@namzu/openai — chat() error mapping', () => {
	it('maps a 429 to throttle with retryAfterMs from the Retry-After header', async () => {
		const err = APIError.generate(
			429,
			openaiBody({ message: 'rate limited', type: 'rate_limit_error' }),
			undefined,
			new Headers({ 'retry-after': '12' }),
		)
		createMock.mockRejectedValueOnce(err)

		const caught = await newProvider()
			.chat({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] })
			.catch((e: unknown) => e)

		expect(isProviderRequestError(caught)).toBe(true)
		const pe = caught as ProviderRequestError
		expect(pe.kind).toBe('throttle')
		expect(pe.status).toBe(429)
		expect(pe.retryAfterMs).toBe(12_000)
		expect(pe.providerId).toBe('openai')
		expect(pe.cause).toBe(err)
	})

	it('reads retryAfterMs from x-ratelimit-reset-tokens duration when Retry-After is absent', async () => {
		const err = APIError.generate(
			429,
			openaiBody({ message: 'rate limited', type: 'rate_limit_error' }),
			undefined,
			new Headers({ 'x-ratelimit-reset-tokens': '1s' }),
		)
		createMock.mockRejectedValueOnce(err)

		const pe = (await newProvider()
			.chat({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] })
			.catch((e: unknown) => e)) as ProviderRequestError

		expect(pe.kind).toBe('throttle')
		expect(pe.retryAfterMs).toBe(1_000)
	})

	it('maps a 500 to server', async () => {
		const err = APIError.generate(
			500,
			openaiBody({ message: 'internal', type: 'server_error' }),
			undefined,
			new Headers(),
		)
		createMock.mockRejectedValueOnce(err)

		const pe = (await newProvider()
			.chat({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] })
			.catch((e: unknown) => e)) as ProviderRequestError

		expect(pe.kind).toBe('server')
		expect(pe.status).toBe(500)
	})

	it('maps a connection failure to network', async () => {
		const err = new APIConnectionError({ message: 'ECONNRESET' })
		createMock.mockRejectedValueOnce(err)

		const pe = (await newProvider()
			.chat({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] })
			.catch((e: unknown) => e)) as ProviderRequestError

		expect(pe.kind).toBe('network')
		expect(pe.status).toBeUndefined()
	})

	it('maps a 401 to auth', async () => {
		const err = APIError.generate(
			401,
			openaiBody({ message: 'invalid api key', type: 'invalid_request_error' }),
			undefined,
			new Headers(),
		)
		createMock.mockRejectedValueOnce(err)

		const pe = (await newProvider()
			.chat({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] })
			.catch((e: unknown) => e)) as ProviderRequestError

		expect(pe.kind).toBe('auth')
		expect(pe.status).toBe(401)
	})

	it('maps a context_length_exceeded 400 to context_overflow', async () => {
		const err = APIError.generate(
			400,
			openaiBody({
				message: "This model's maximum context length is 128000 tokens.",
				type: 'invalid_request_error',
				code: 'context_length_exceeded',
			}),
			undefined,
			new Headers(),
		)
		createMock.mockRejectedValueOnce(err)

		const pe = (await newProvider()
			.chat({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] })
			.catch((e: unknown) => e)) as ProviderRequestError

		expect(pe.kind).toBe('context_overflow')
		expect(pe.status).toBe(400)
	})

	it('maps an unrelated 400 to bad_request', async () => {
		const err = APIError.generate(
			400,
			openaiBody({
				message: 'invalid temperature',
				type: 'invalid_request_error',
				code: 'invalid_value',
			}),
			undefined,
			new Headers(),
		)
		createMock.mockRejectedValueOnce(err)

		const pe = (await newProvider()
			.chat({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] })
			.catch((e: unknown) => e)) as ProviderRequestError

		expect(pe.kind).toBe('bad_request')
		expect(pe.status).toBe(400)
	})

	it('maps a user abort to aborted', async () => {
		createMock.mockRejectedValueOnce(new APIUserAbortError())

		const pe = (await newProvider()
			.chat({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] })
			.catch((e: unknown) => e)) as ProviderRequestError

		expect(pe.kind).toBe('aborted')
	})
})

describe('@namzu/openai — signal + maxRetries plumbing', () => {
	it('passes { signal, maxRetries: 0 } as the second RequestOptions argument', async () => {
		createMock.mockResolvedValueOnce(OK_RESPONSE)
		const signal = new AbortController().signal

		await newProvider().chat({
			model: 'gpt-x',
			messages: [{ role: 'user', content: 'hi' }],
			signal,
		})

		expect(createMock).toHaveBeenCalledTimes(1)
		const [, options] = createMock.mock.calls[0]!
		expect(options.signal).toBe(signal)
		expect(options.maxRetries).toBe(0)
	})
})

describe('@namzu/openai — serializer round-trip', () => {
	it('serializes an interrupted tool history to the OpenAI wire format without throwing', async () => {
		createMock.mockResolvedValueOnce(OK_RESPONSE)

		const history: Message[] = [
			{ role: 'system', content: 'You are a test.' },
			{ role: 'user', content: 'run the tools' },
			{
				role: 'assistant',
				content: null,
				toolCalls: [
					{ id: 'call_empty', type: 'function', function: { name: 'noop', arguments: '{}' } },
					{
						id: 'call_read',
						type: 'function',
						function: { name: 'read', arguments: '{"path":"/tmp"}' },
					},
				],
			},
			{ role: 'tool', toolCallId: 'call_read', content: 'file contents' },
			{
				role: 'tool',
				toolCallId: 'call_empty',
				content: '[SYSTEM] Tool result missing: run was interrupted before this tool completed.',
			},
		]

		await expect(newProvider().chat({ model: 'gpt-x', messages: history })).resolves.toBeDefined()

		const [body] = createMock.mock.calls[0]!
		const messages = body.messages as Array<{
			role: string
			content: unknown
			tool_calls?: Array<{ id: string; function: { arguments: string } }>
			tool_call_id?: string
		}>

		// Assistant tool_calls preserve the raw argument strings, including '{}'.
		const assistant = messages.find((m) => m.role === 'assistant')!
		expect(assistant.tool_calls?.map((t) => t.id)).toEqual(['call_empty', 'call_read'])
		expect(assistant.tool_calls?.[0]!.function.arguments).toBe('{}')
		expect(assistant.tool_calls?.[1]!.function.arguments).toBe('{"path":"/tmp"}')

		// Both tool results become role:'tool' messages keyed by tool_call_id.
		const toolMessages = messages.filter((m) => m.role === 'tool')
		expect(toolMessages.map((m) => m.tool_call_id)).toEqual(['call_read', 'call_empty'])
	})
})
