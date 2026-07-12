import { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import type { Message } from '@namzu/sdk'
import { type ProviderRequestError, isProviderRequestError } from '@namzu/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AnthropicProvider } from '../client.js'

// Current-code invariants asserted (2026-07-12, ses_015 Phase B):
// - chat() maps every vendor SDK error class onto the ProviderRequestError
//   taxonomy: 429→throttle (with retryAfterMs from Retry-After), 500→server,
//   APIConnectionError→network, 401→auth, over-long-prompt 400→context_overflow,
//   plain 400→bad_request, APIUserAbortError→aborted.
// - createRaw passes { signal, maxRetries: 0 } as the second RequestOptions arg so
//   the vendor SDK performs no internal retries.
// - the serializer converts an interrupted history (assistant toolCalls with a
//   '{}'-arguments call + a synthesized '[SYSTEM] Tool result missing...' result)
//   to the Anthropic wire format without throwing.

// Mock only the vendor client (default export); keep the real error classes so
// the adapter's instanceof-based mapping matches the errors the tests throw.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }))

vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>()
	class MockAnthropic {
		messages = { create: createMock }
	}
	return { ...actual, default: MockAnthropic }
})

const OK_RESPONSE = {
	id: 'msg_1',
	model: 'claude-x',
	content: [{ type: 'text', text: 'hi' }],
	stop_reason: 'end_turn',
	usage: { input_tokens: 1, output_tokens: 1 },
}

function newProvider(): AnthropicProvider {
	return new AnthropicProvider({ apiKey: 'test-key', model: 'claude-x' })
}

function anthropicBody(
	type: string,
	message: string,
): { type: 'error'; error: { type: string; message: string } } {
	return { type: 'error', error: { type, message } }
}

beforeEach(() => {
	createMock.mockReset()
})

describe('@namzu/anthropic — chat() error mapping', () => {
	it('maps a 429 to throttle with retryAfterMs from the Retry-After header', async () => {
		const err = APIError.generate(
			429,
			anthropicBody('rate_limit_error', 'rate limited'),
			undefined,
			new Headers({ 'retry-after': '30' }),
		)
		createMock.mockRejectedValueOnce(err)

		const caught = await newProvider()
			.chat({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] })
			.catch((e: unknown) => e)

		expect(isProviderRequestError(caught)).toBe(true)
		const pe = caught as ProviderRequestError
		expect(pe.kind).toBe('throttle')
		expect(pe.status).toBe(429)
		expect(pe.retryAfterMs).toBe(30_000)
		expect(pe.providerId).toBe('anthropic')
		expect(pe.cause).toBe(err)
	})

	it('reads retryAfterMs from anthropic-ratelimit-*-reset when Retry-After is absent', async () => {
		const resetAt = new Date(Date.now() + 5_000).toISOString()
		const err = APIError.generate(
			429,
			anthropicBody('rate_limit_error', 'rate limited'),
			undefined,
			new Headers({ 'anthropic-ratelimit-tokens-reset': resetAt }),
		)
		createMock.mockRejectedValueOnce(err)

		const pe = (await newProvider()
			.chat({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] })
			.catch((e: unknown) => e)) as ProviderRequestError

		expect(pe.kind).toBe('throttle')
		// Roughly 5s out; allow scheduling slack.
		expect(pe.retryAfterMs).toBeGreaterThan(3_000)
		expect(pe.retryAfterMs).toBeLessThanOrEqual(5_000)
	})

	it('maps a 500 to server', async () => {
		const err = APIError.generate(
			500,
			anthropicBody('api_error', 'internal'),
			undefined,
			new Headers(),
		)
		createMock.mockRejectedValueOnce(err)

		const pe = (await newProvider()
			.chat({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] })
			.catch((e: unknown) => e)) as ProviderRequestError

		expect(pe.kind).toBe('server')
		expect(pe.status).toBe(500)
	})

	it('maps a connection failure to network', async () => {
		const err = new APIConnectionError({ message: 'socket hang up' })
		createMock.mockRejectedValueOnce(err)

		const pe = (await newProvider()
			.chat({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] })
			.catch((e: unknown) => e)) as ProviderRequestError

		expect(pe.kind).toBe('network')
		expect(pe.status).toBeUndefined()
	})

	it('maps a 401 to auth', async () => {
		const err = APIError.generate(
			401,
			anthropicBody('authentication_error', 'invalid x-api-key'),
			undefined,
			new Headers(),
		)
		createMock.mockRejectedValueOnce(err)

		const pe = (await newProvider()
			.chat({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] })
			.catch((e: unknown) => e)) as ProviderRequestError

		expect(pe.kind).toBe('auth')
		expect(pe.status).toBe(401)
	})

	it('maps an over-long-prompt 400 to context_overflow', async () => {
		const err = APIError.generate(
			400,
			anthropicBody('invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum'),
			undefined,
			new Headers(),
		)
		createMock.mockRejectedValueOnce(err)

		const pe = (await newProvider()
			.chat({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] })
			.catch((e: unknown) => e)) as ProviderRequestError

		expect(pe.kind).toBe('context_overflow')
		expect(pe.status).toBe(400)
	})

	it('maps an unrelated 400 to bad_request', async () => {
		const err = APIError.generate(
			400,
			anthropicBody('invalid_request_error', 'messages: at least one message is required'),
			undefined,
			new Headers(),
		)
		createMock.mockRejectedValueOnce(err)

		const pe = (await newProvider()
			.chat({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] })
			.catch((e: unknown) => e)) as ProviderRequestError

		expect(pe.kind).toBe('bad_request')
		expect(pe.status).toBe(400)
	})

	it('maps a user abort to aborted', async () => {
		createMock.mockRejectedValueOnce(new APIUserAbortError())

		const pe = (await newProvider()
			.chat({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] })
			.catch((e: unknown) => e)) as ProviderRequestError

		expect(pe.kind).toBe('aborted')
	})
})

describe('@namzu/anthropic — signal + maxRetries plumbing', () => {
	it('passes { signal, maxRetries: 0 } as the second RequestOptions argument', async () => {
		createMock.mockResolvedValueOnce(OK_RESPONSE)
		const signal = new AbortController().signal

		await newProvider().chat({
			model: 'claude-x',
			messages: [{ role: 'user', content: 'hi' }],
			signal,
		})

		expect(createMock).toHaveBeenCalledTimes(1)
		const [, options] = createMock.mock.calls[0]!
		expect(options.signal).toBe(signal)
		expect(options.maxRetries).toBe(0)
	})
})

describe('@namzu/anthropic — serializer round-trip', () => {
	it('serializes an interrupted tool history to the Anthropic wire format without throwing', async () => {
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

		await expect(
			newProvider().chat({ model: 'claude-x', messages: history }),
		).resolves.toBeDefined()

		const [body] = createMock.mock.calls[0]!
		const messages = body.messages as Array<{ role: string; content: unknown }>

		// Assistant tool_use blocks carry parsed input; '{}' args parse to an empty object.
		const assistant = messages.find((m) => m.role === 'assistant')!
		const blocks = assistant.content as Array<{ type: string; id?: string; input?: unknown }>
		const toolUses = blocks.filter((b) => b.type === 'tool_use')
		expect(toolUses.map((b) => b.id)).toEqual(['call_empty', 'call_read'])
		expect(toolUses[0]!.input).toEqual({})
		expect(toolUses[1]!.input).toEqual({ path: '/tmp' })

		// Both tool results become tool_result blocks in a trailing user message.
		const toolResultBlocks = messages
			.filter((m) => m.role === 'user')
			.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
			.filter((b: { type?: string }) => b.type === 'tool_result')
		expect(toolResultBlocks).toHaveLength(2)
	})
})
