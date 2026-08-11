/**
 * The model reaches the wrapped driver's health probe.
 *
 * `healthCheck` and `doctorCheck` carry the model the caller intends to run,
 * because at least one driver's config does not hold one and so cannot probe
 * without it. Both decorators rebuild the provider object as a literal, and a
 * literal that spells the forwarded method `() => provider.healthCheck?.()`
 * drops the argument silently: the call still happens, the wrapped driver still
 * answers, and the answer is "there was nothing to check" — an unusable probe
 * produced by wrapping alone, with no type error anywhere.
 *
 * So the wrappers are driven rather than read. Counting call sites in the
 * source would not have caught it either way.
 *
 * The fallback cases use a TWO-member chain deliberately. A one-member chain is
 * the identity — `withProviderFallback` returns the provider itself — so the
 * first draft of these tests passed against a wrapper that dropped the model,
 * because it never reached a wrapper at all. Mutation is what said so.
 */

import { describe, expect, it } from 'vitest'

import type { ChatCompletionParams, LLMProvider, StreamChunk } from '../../types/provider/index.js'
import { withProviderFallback } from '../fallback.js'
import { withProviderRetry } from '../retry.js'

/** A driver that answers only when it is told which model to probe. */
function modelAwareProvider(): { provider: LLMProvider; asked: Array<string | undefined> } {
	const asked: Array<string | undefined> = []
	const provider: LLMProvider = {
		id: 'probe',
		name: 'Probe',
		// biome-ignore lint/correctness/useYield: the stream is never iterated here
		async *chatStream(_params: ChatCompletionParams): AsyncIterable<StreamChunk> {
			throw new Error('chatStream is not the subject of these tests')
		},
		async healthCheck(model?: string) {
			asked.push(model)
			return model !== undefined
		},
		async doctorCheck(model?: string) {
			asked.push(model)
			return { status: model === undefined ? ('skipped' as const) : ('pass' as const) }
		},
	}
	return { provider, asked }
}

/** A second chain member, so the decorator is a wrapper rather than identity. */
function spareMember(): LLMProvider {
	return {
		id: 'spare',
		name: 'Spare',
		// biome-ignore lint/correctness/useYield: never reached
		async *chatStream(_params: ChatCompletionParams): AsyncIterable<StreamChunk> {
			throw new Error('the spare member is never asked anything')
		},
	}
}

describe('the retry decorator forwards the model', () => {
	it('hands healthCheck the model it was called with', async () => {
		const { provider, asked } = modelAwareProvider()

		const wrapped = withProviderRetry(provider)

		expect(await wrapped.healthCheck?.('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(true)
		expect(asked).toEqual(['us.anthropic.claude-sonnet-4-5-20250929-v1:0'])
	})

	it('hands doctorCheck the model it was called with', async () => {
		const { provider, asked } = modelAwareProvider()

		const wrapped = withProviderRetry(provider)
		const result = await wrapped.doctorCheck?.('amazon.nova-pro-v1:0')

		expect(result?.status).toBe('pass')
		expect(asked).toEqual(['amazon.nova-pro-v1:0'])
	})

	it('still passes nothing through when the caller passed nothing', async () => {
		const { provider, asked } = modelAwareProvider()

		const wrapped = withProviderRetry(provider)

		// The preservation half: a wrapper that invented a model would be as
		// wrong as one that dropped it.
		expect(await wrapped.healthCheck?.()).toBe(false)
		expect(asked).toEqual([undefined])
	})
})

describe('the fallback decorator forwards the model', () => {
	it('hands healthCheck the model it was called with', async () => {
		const { provider, asked } = modelAwareProvider()

		const wrapped = withProviderFallback([
			{ provider, model: 'primary' },
			{ provider: spareMember(), model: 'spare' },
		])

		expect(await wrapped.healthCheck?.('amazon.nova-pro-v1:0')).toBe(true)
		expect(asked).toEqual(['amazon.nova-pro-v1:0'])
	})

	it('hands doctorCheck the model it was called with', async () => {
		const { provider, asked } = modelAwareProvider()

		const wrapped = withProviderFallback([
			{ provider, model: 'primary' },
			{ provider: spareMember(), model: 'spare' },
		])
		const result = await wrapped.doctorCheck?.('us.anthropic.claude-haiku-4-5-20251001-v1:0')

		expect(result?.status).toBe('pass')
		expect(asked).toEqual(['us.anthropic.claude-haiku-4-5-20251001-v1:0'])
	})

	it('probes the chain HEAD, which is the member a request would reach first', async () => {
		const { provider, asked } = modelAwareProvider()

		const wrapped = withProviderFallback([
			{ provider, model: 'primary' },
			{ provider: spareMember(), model: 'spare' },
		])
		await wrapped.healthCheck?.('amazon.nova-pro-v1:0')

		// One member asked, not two: the probe is not a survey of the chain.
		expect(asked).toHaveLength(1)
	})
})
