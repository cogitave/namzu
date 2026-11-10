import { describe, expect, it } from 'vitest'

import { collectChatCompletion } from '../../../../provider/collect-chat-completion.js'
import { ProviderRequestError } from '../../../../provider/errors.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../../types/provider/index.js'
import { classifyRequestRejection } from '../request-repair.js'
import { chatStreamWithSamplingRepair } from '../side-call.js'

const USAGE = {
	promptTokens: 1,
	completionTokens: 1,
	totalTokens: 2,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

/** A provider whose model refuses the named parameters the way the vendor words it. */
function strictProvider(refuses: Array<'temperature' | 'topP' | 'topK'>, detail: string) {
	const requests: ChatCompletionParams[] = []
	const fake: LLMProvider = {
		id: 'fake',
		name: 'Fake',
		async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
			requests.push(params)
			if (refuses.some((name) => params[name] !== undefined)) {
				throw new ProviderRequestError({
					kind: 'bad_request',
					providerId: 'fake',
					status: 400,
					detail,
				})
			}
			yield { id: 'm', delta: { content: 'ok' }, finishReason: 'stop', usage: USAGE }
		},
	} as unknown as LLMProvider
	return { fake, requests }
}

const params: ChatCompletionParams = {
	model: 'm-1',
	messages: [{ role: 'user', content: 'hi' }],
	temperature: 0,
}
const VENDOR_WORDING =
	'`temperature` is deprecated for this model. Sampling parameters are not supported: omit temperature, top_p, and top_k.'

describe('side calls on a model that refuses sampling parameters', () => {
	it('resends without temperature and returns the answer', async () => {
		const { fake, requests } = strictProvider(['temperature'], VENDOR_WORDING)
		const response = await collectChatCompletion(chatStreamWithSamplingRepair(fake, params))
		expect(response.message.content).toBe('ok')
		expect(requests.map((r) => r.temperature)).toEqual([0, undefined])
	})

	it('remembers the finding for later calls to that model', async () => {
		const { fake, requests } = strictProvider(['temperature'], VENDOR_WORDING)
		await collectChatCompletion(chatStreamWithSamplingRepair(fake, params))
		await collectChatCompletion(chatStreamWithSamplingRepair(fake, params))
		expect(requests.map((r) => r.temperature)).toEqual([0, undefined, undefined])
	})

	it('does not carry the finding to another model', async () => {
		const { fake, requests } = strictProvider(['temperature'], VENDOR_WORDING)
		await collectChatCompletion(chatStreamWithSamplingRepair(fake, params))
		await collectChatCompletion(chatStreamWithSamplingRepair(fake, { ...params, model: 'm-2' }))
		expect(requests.at(2)?.temperature).toBe(0)
	})

	it('does not touch a provider that accepts the request', async () => {
		const { fake, requests } = strictProvider([], '')
		await collectChatCompletion(chatStreamWithSamplingRepair(fake, params))
		expect(requests).toHaveLength(1)
		expect(requests[0]?.temperature).toBe(0)
	})

	it('throws any other rejection unchanged', async () => {
		const { fake, requests } = strictProvider(['temperature'], 'messages: roles must alternate')
		await expect(
			collectChatCompletion(chatStreamWithSamplingRepair(fake, params)),
		).rejects.toMatchObject({ detail: 'messages: roles must alternate' })
		expect(requests).toHaveLength(1)
	})

	it('forgets a guess whose resend failed too', async () => {
		const requests: ChatCompletionParams[] = []
		const fake = {
			id: 'fake',
			name: 'Fake',
			// biome-ignore lint/correctness/useYield: always rejects
			async *chatStream(p: ChatCompletionParams): AsyncIterable<StreamChunk> {
				requests.push(p)
				throw new ProviderRequestError({
					kind: 'bad_request',
					providerId: 'fake',
					status: 400,
					detail: VENDOR_WORDING,
				})
			},
		} as unknown as LLMProvider
		await expect(
			collectChatCompletion(chatStreamWithSamplingRepair(fake, params)),
		).rejects.toBeInstanceOf(ProviderRequestError)
		await expect(
			collectChatCompletion(chatStreamWithSamplingRepair(fake, params)),
		).rejects.toBeInstanceOf(ProviderRequestError)
		// Both calls started from the original request.
		expect(requests.map((r) => r.temperature)).toEqual([0, undefined, 0, undefined])
	})
})

describe('top_k in the repair', () => {
	const error = (detail: string, code?: string) =>
		new ProviderRequestError({
			kind: 'bad_request',
			providerId: 'fake',
			status: 400,
			detail,
			...(code ? { providerCode: code } : {}),
		})

	it('is recognised when the provider names it', () => {
		const rejection = classifyRequestRejection(error('top_k is not supported for this model'), {
			...params,
			temperature: undefined,
			topK: 40,
		})
		expect(rejection).toEqual({ kind: 'parameter', parameters: ['topK'] })
	})

	it('is recognised from the grouped wording, and only for what was sent', () => {
		const rejection = classifyRequestRejection(error(VENDOR_WORDING), { ...params, topK: 40 })
		expect(rejection).toEqual({ kind: 'parameter', parameters: ['temperature', 'topK'] })
	})

	it('is not read from a request that never sent it', () => {
		expect(classifyRequestRejection(error('top_k is not supported'), params)).toBeNull()
	})
})
