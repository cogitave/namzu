/**
 * A wrapped driver's refusal-fallback choice reaches the runtime.
 *
 * The retry, idle-timeout and fallback decorators rebuild the provider as a
 * literal. A literal that forgets `refusalFallbackFor` turns the recovery off
 * silently: the refused reply is declined instead of moved to another model,
 * with no type error anywhere. So the wrappers are driven, with the arguments
 * checked, rather than read.
 */

import { describe, expect, it } from 'vitest'

import type { ChatCompletionParams, LLMProvider, StreamChunk } from '../../types/provider/index.js'
import { withProviderFallback } from '../fallback.js'
import { withStreamIdleTimeout } from '../idle-timeout.js'
import { withProviderRetry } from '../retry.js'

const refusal = { category: 'cyber', explanation: 'flagged' }

function driver(
	id: string,
	choose?: (model: string) => string | undefined,
): { provider: LLMProvider; asked: Array<{ model: string; refusal: unknown }> } {
	const asked: Array<{ model: string; refusal: unknown }> = []
	const provider: LLMProvider = {
		id,
		name: id,
		// biome-ignore lint/correctness/useYield: the stream is never iterated here
		async *chatStream(_params: ChatCompletionParams): AsyncIterable<StreamChunk> {
			throw new Error('chatStream is not the subject of these tests')
		},
		...(choose
			? {
					refusalFallbackFor: async (model: string, given: unknown) => {
						asked.push({ model, refusal: given })
						return choose(model)
					},
				}
			: {}),
	}
	return { provider, asked }
}

describe('refusalFallbackFor survives each decorator', () => {
	it('retry forwards the model and the refusal, and the answer', async () => {
		const { provider, asked } = driver('a', () => 'other')
		const wrapped = withProviderRetry(provider)
		expect(await wrapped.refusalFallbackFor?.('m1', refusal)).toBe('other')
		expect(asked).toEqual([{ model: 'm1', refusal }])
	})

	it('idle timeout forwards the model and the refusal, and the answer', async () => {
		const { provider, asked } = driver('a', () => 'other')
		const wrapped = withStreamIdleTimeout(provider, { idleTimeoutMs: 1_000 })
		expect(await wrapped.refusalFallbackFor?.('m1', refusal)).toBe('other')
		expect(asked).toEqual([{ model: 'm1', refusal }])
	})

	it('a driver with no choice adds none', () => {
		const { provider } = driver('a')
		expect(withProviderRetry(provider).refusalFallbackFor).toBeUndefined()
		expect(withStreamIdleTimeout(provider, { idleTimeoutMs: 1_000 }).refusalFallbackFor).toBe(
			undefined,
		)
	})

	it('a two-member chain asks the member serving the request', async () => {
		const first = driver('first', (model) => `${model}-alt`)
		const second = driver('second', () => 'second-alt')
		const chain = withProviderFallback([
			{ provider: first.provider },
			{ provider: second.provider },
		])
		expect(await chain.refusalFallbackFor?.('m1', refusal)).toBe('m1-alt')
		expect(first.asked).toEqual([{ model: 'm1', refusal }])
		expect(second.asked).toEqual([])
	})

	it('a chain whose members name no choice adds none', () => {
		const chain = withProviderFallback([
			{ provider: driver('first').provider },
			{ provider: driver('second').provider },
		])
		expect(chain.refusalFallbackFor).toBeUndefined()
	})
})
