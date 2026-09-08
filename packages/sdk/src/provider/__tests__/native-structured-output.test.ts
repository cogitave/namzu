import { describe, expect, it, vi } from 'vitest'
import { streamProviderTurn } from '../../runtime/query/iteration/stream-turn.js'
import type { RunId } from '../../types/ids/index.js'
import type { ChatCompletionParams, LLMProvider, StreamChunk } from '../../types/provider/index.js'
import { resolveLogger } from '../../utils/logger.js'
import { resolveProviderCapabilities } from '../capabilities.js'
import { ProviderRequestError } from '../errors.js'
import { withProviderFallback } from '../fallback.js'

const request: ChatCompletionParams = {
	model: 'test',
	messages: [],
	responseFormat: {
		type: 'json_schema',
		json_schema: { name: 'answer', schema: { type: 'object' }, strict: true },
	},
}

function provider(id: string, supported?: boolean, fails = false) {
	const chatStream = vi.fn(async function* (
		_params: ChatCompletionParams,
	): AsyncIterable<StreamChunk> {
		if (fails) throw new ProviderRequestError({ providerId: id, kind: 'server', status: 503 })
		yield { id: 'c', delta: { content: '{}' }, finishReason: 'stop' as const }
	})
	return {
		id,
		name: id,
		chatStream,
		...(supported === undefined
			? {}
			: {
					capabilities: {
						supportsTools: true,
						supportsStreaming: true,
						supportsFunctionCalling: true,
						supportsNativeStructuredOutput: supported,
					},
				}),
	} as LLMProvider & { chatStream: typeof chatStream }
}

async function drain(stream: AsyncIterable<unknown>) {
	for await (const _chunk of stream) {
		/* consume */
	}
}

const unsupported = {
	kind: 'bad_request',
	providerCode: 'native_structured_output_unsupported',
}

describe('native structured output route admission', () => {
	it.each([undefined, false])(
		'rejects a direct route with capability %s before dispatch',
		async (supported) => {
			const target = provider('direct', supported)
			await expect(
				drain(
					streamProviderTurn(
						target,
						request,
						async () => {},
						function* () {},
						'run' as RunId,
						1,
						false,
						resolveLogger(undefined),
					),
				),
			).rejects.toMatchObject(unsupported)
			expect(target.chatStream).not.toHaveBeenCalled()
		},
	)

	it('allows a direct explicitly capable route with its exact schema', async () => {
		const target = provider('direct', true)
		await drain(
			streamProviderTurn(
				target,
				request,
				async () => {},
				function* () {},
				'run' as RunId,
				1,
				false,
				resolveLogger(undefined),
			),
		)
		expect(target.chatStream).toHaveBeenCalledWith(
			expect.objectContaining({ responseFormat: request.responseFormat }),
		)
	})

	it.each([undefined, false])(
		'rejects an unsupported fallback %s after a capable primary fails',
		async (supported) => {
			const first = provider('first', true, true)
			const next = provider('next', supported)
			const chain = withProviderFallback([{ provider: first }, { provider: next }])
			await expect(drain(chain.chatStream(request))).rejects.toMatchObject({
				...unsupported,
				providerId: 'next',
			})
			expect(first.chatStream).toHaveBeenCalledTimes(1)
			expect(next.chatStream).not.toHaveBeenCalled()
		},
	)

	it('admits a capable fallback and preserves the schema and actual route model', async () => {
		const first = provider('first', true, true)
		const next = provider('next', true)
		await drain(
			withProviderFallback([
				{ provider: first },
				{ provider: next, model: 'second-model' },
			]).chatStream(request),
		)
		expect(next.chatStream).toHaveBeenCalledWith(
			expect.objectContaining({ model: 'second-model', responseFormat: request.responseFormat }),
		)
	})

	it('does not guess support or advance the chain from an unsupported primary', async () => {
		const first = provider('first')
		const next = provider('next', true)
		await expect(
			drain(withProviderFallback([{ provider: first }, { provider: next }]).chatStream(request)),
		).rejects.toMatchObject(unsupported)
		expect(first.chatStream).not.toHaveBeenCalled()
		expect(next.chatStream).not.toHaveBeenCalled()
	})

	it.each([undefined, { type: 'json_object' as const }])(
		'preserves legacy requests with responseFormat %s',
		async (responseFormat) => {
			const target = provider('legacy')
			await drain(
				withProviderFallback([{ provider: target }]).chatStream({ ...request, responseFormat }),
			)
			expect(target.chatStream).toHaveBeenCalledTimes(1)
			expect(resolveProviderCapabilities(target).supportsTools).toBe(true)
		},
	)
})
