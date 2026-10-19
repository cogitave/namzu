import { describe, expect, it } from 'vitest'

import { ProviderRequestError } from '../../../provider/errors.js'
import {
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import { RequestRepair, classifyRequestRejection } from '../iteration/request-repair.js'

const USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}
const call = { id: 'call_1', type: 'function' as const, function: { name: 'x', arguments: '{}' } }

function provider(reject: (p: ChatCompletionParams) => string | undefined) {
	const requests: ChatCompletionParams[] = []
	const fake: LLMProvider = {
		id: 'fake',
		name: 'Fake',
		async *chatStream(params): AsyncIterable<StreamChunk> {
			requests.push(params)
			const detail = reject(params)
			if (detail !== undefined) {
				throw new ProviderRequestError({
					kind: 'bad_request',
					providerId: 'fake',
					status: 400,
					detail,
				})
			}
			yield { id: 'a', delta: { content: 'ok' } }
			yield { id: 'a', delta: {}, finishReason: 'stop', usage: USAGE }
		},
	}
	return { fake, requests }
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
	for await (const _ of stream) {
		// drained
	}
}

const base = (messages: ChatCompletionParams['messages']): ChatCompletionParams => ({
	model: 'm1',
	messages,
})

describe('tool pairing before every send', () => {
	const dangling = () => [
		createUserMessage('go'),
		createAssistantMessage('calling', [call]),
		createUserMessage('next'),
	]

	it('gives an unanswered call a result before the first send, without a rejection', async () => {
		const { fake, requests } = provider(() => undefined)
		const messages = dangling()
		await drain(new RequestRepair().stream(fake, base(messages)))
		expect(requests).toHaveLength(1)
		expect(requests[0]?.messages.some((m) => m.role === 'tool')).toBe(true)
		// Stored history is untouched.
		expect(messages.some((m) => m.role === 'tool')).toBe(false)
	})

	it('removes an orphan result', async () => {
		const { fake, requests } = provider(() => undefined)
		await drain(
			new RequestRepair().stream(
				fake,
				base([
					createUserMessage('go'),
					createToolMessage('stray', 'call_x'),
					createUserMessage('n'),
				]),
			),
		)
		expect(requests[0]?.messages.some((m) => m.role === 'tool')).toBe(false)
	})
})

describe('what is retried', () => {
	it('leaves an unrelated 400 alone', async () => {
		const { fake, requests } = provider(() => 'messages: text content blocks must be non-empty')
		await expect(
			drain(new RequestRepair().stream(fake, base([createUserMessage('hi')]))),
		).rejects.toBeInstanceOf(ProviderRequestError)
		expect(requests).toHaveLength(1)
	})

	it('does not repeat a repair that did not help', async () => {
		const { fake, requests } = provider(() => 'Unsupported value: temperature does not support 0.2')
		await expect(
			drain(
				new RequestRepair().stream(fake, { ...base([createUserMessage('hi')]), temperature: 0.2 }),
			),
		).rejects.toBeInstanceOf(ProviderRequestError)
		// One resend without the parameter; the second rejection names nothing left to drop.
		expect(requests).toHaveLength(2)
	})

	it('remembers a refused parameter for the route, so later sends do not fail first', async () => {
		const { fake, requests } = provider((p) =>
			p.effort !== undefined ? "Unsupported parameter: 'reasoning_effort'" : undefined,
		)
		const repair = new RequestRepair()
		await drain(repair.stream(fake, { ...base([createUserMessage('a')]), effort: 'high' }))
		await drain(repair.stream(fake, { ...base([createUserMessage('b')]), effort: 'high' }))
		expect(requests.map((r) => r.effort)).toEqual(['high', undefined, undefined])
		// Another model is asked again.
		await drain(
			repair.stream(fake, { ...base([createUserMessage('c')]), model: 'm2', effort: 'high' }),
		)
		expect(requests[3]?.effort).toBe('high')
	})

	it('does not resend once output has begun', async () => {
		let sent = 0
		const fake: LLMProvider = {
			id: 'fake',
			name: 'Fake',
			async *chatStream(): AsyncIterable<StreamChunk> {
				sent++
				yield { id: 'a', delta: { content: 'partial' } }
				throw new ProviderRequestError({
					kind: 'bad_request',
					providerId: 'fake',
					status: 400,
					detail: 'Invalid `signature` in `thinking` block',
				})
			},
		}
		await expect(
			drain(new RequestRepair().stream(fake, base([createUserMessage('hi')]))),
		).rejects.toBeInstanceOf(ProviderRequestError)
		expect(sent).toBe(1)
	})
})

describe('classifyRequestRejection', () => {
	const params = { ...base([]), temperature: 0.1, effort: 'low' as const }
	const reject = (detail: string, providerCode?: string) =>
		new ProviderRequestError({
			kind: 'bad_request',
			providerId: 'p',
			status: 400,
			detail,
			...(providerCode ? { providerCode } : {}),
		})

	it.each([
		['Invalid `signature` in `thinking` block', undefined, 'reasoning'],
		['Corrupted thought signature.', undefined, 'reasoning'],
		[
			"Item 'rs_123' of type 'reasoning' was provided without its required following item.",
			undefined,
			'reasoning',
		],
		['bad', 'invalid_encrypted_content', 'reasoning'],
		[
			'`tool_use` ids were found without `tool_result` blocks immediately after: call_1',
			undefined,
			'tool-pairing',
		],
		[
			"messages with role 'tool' must be a response to a preceeding message with 'tool_calls'",
			undefined,
			'tool-pairing',
		],
		[
			'Expected toolResult blocks at messages.2.content for the following Ids: call_1',
			undefined,
			'tool-pairing',
		],
		['image exceeds 5 MB maximum', undefined, 'media'],
		['Request rejected as unprocessable', undefined, 'media'],
		['bad', 'invalid_image', 'media'],
		["'temperature' is deprecated for this model", undefined, 'parameter'],
	])('%s -> %s', (detail, code, kind) => {
		expect(classifyRequestRejection(reject(detail, code), params)?.kind).toBe(kind)
	})

	it('ignores a context overflow, an auth failure and a non-400', () => {
		const overflow = new ProviderRequestError({
			kind: 'context_overflow',
			providerId: 'p',
			status: 400,
		})
		const server = new ProviderRequestError({ kind: 'server', providerId: 'p', status: 500 })
		expect(classifyRequestRejection(overflow, params)).toBeNull()
		expect(classifyRequestRejection(server, params)).toBeNull()
		expect(classifyRequestRejection(new Error('boom'), params)).toBeNull()
	})

	it('does not name a parameter the request never set', () => {
		expect(classifyRequestRejection(reject('top_p is not supported'), { ...base([]) })).toBeNull()
	})
})
