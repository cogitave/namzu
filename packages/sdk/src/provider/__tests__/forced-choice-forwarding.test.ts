/**
 * A wrapped driver's answer about a forced tool choice reaches the runtime.
 *
 * The decorators rebuild the provider as a literal, and a literal that forgets
 * `acceptsForcedToolChoiceFor` turns the answer into "accepted" silently, so a
 * stalled run on a model that refuses a forced choice fails its turn again. The
 * wrappers are driven, with the arguments checked, rather than read.
 */

import { describe, expect, it } from 'vitest'

import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
	ThinkingConfig,
} from '../../types/provider/index.js'
import { withProviderFallback } from '../fallback.js'
import { withStreamIdleTimeout } from '../idle-timeout.js'
import { withModelWindowSuffixStripped } from '../model-window-suffix.js'
import { withProviderRetry } from '../retry.js'

function driver(
	id: string,
	accepts?: (model: string, thinking?: ThinkingConfig) => boolean,
): { provider: LLMProvider; asked: Array<{ model: string; thinking?: ThinkingConfig }> } {
	const asked: Array<{ model: string; thinking?: ThinkingConfig }> = []
	const provider: LLMProvider = {
		id,
		name: id,
		// biome-ignore lint/correctness/useYield: the stream is never iterated here
		async *chatStream(_params: ChatCompletionParams): AsyncIterable<StreamChunk> {
			throw new Error('chatStream is not the subject of these tests')
		},
		...(accepts
			? {
					acceptsForcedToolChoiceFor: (model: string, thinking?: ThinkingConfig) => {
						asked.push({ model, ...(thinking ? { thinking } : {}) })
						return accepts(model, thinking)
					},
				}
			: {}),
	}
	return { provider, asked }
}

const manual: ThinkingConfig = { type: 'enabled', budgetTokens: 1024 }

describe('acceptsForcedToolChoiceFor survives each decorator', () => {
	it.each([
		['retry', (p: LLMProvider) => withProviderRetry(p)],
		['idle timeout', (p: LLMProvider) => withStreamIdleTimeout(p, { idleTimeoutMs: 1000 })],
		['window marker', (p: LLMProvider) => withModelWindowSuffixStripped(p)],
	])('%s forwards the model, the thinking setting and the answer', (_name, wrap) => {
		const { provider, asked } = driver('a', (model) => model !== 'strict')
		const wrapped = wrap(provider)
		expect(wrapped.acceptsForcedToolChoiceFor?.('strict', manual)).toBe(false)
		expect(wrapped.acceptsForcedToolChoiceFor?.('lenient')).toBe(true)
		expect(asked).toEqual([{ model: 'strict', thinking: manual }, { model: 'lenient' }])
	})

	it('a provider that does not declare it is left undeclared, so it is not forced', () => {
		const { provider } = driver('a')
		expect(withProviderRetry(provider).acceptsForcedToolChoiceFor).toBeUndefined()
		expect(
			withStreamIdleTimeout(provider, { idleTimeoutMs: 1000 }).acceptsForcedToolChoiceFor,
		).toBe(undefined)
	})

	it('the window marker is stripped from the model before the driver is asked', () => {
		const { provider, asked } = driver('a', () => true)
		withModelWindowSuffixStripped(provider).acceptsForcedToolChoiceFor?.('claude-x[1m]')
		expect(asked).toEqual([{ model: 'claude-x' }])
	})

	it('a chain accepts only if every member does, each asked about its own model', () => {
		const lenient = driver('a', () => true)
		const strict = driver('b', () => false)
		const silent = driver('c')
		const chain = (members: LLMProvider[]) =>
			withProviderFallback(members.map((provider, i) => ({ provider, model: `m${i}` })))
		expect(chain([lenient.provider, silent.provider]).acceptsForcedToolChoiceFor?.('req')).toBe(
			false,
		)
		expect(chain([lenient.provider, lenient.provider]).acceptsForcedToolChoiceFor?.('req')).toBe(
			true,
		)
		expect(chain([lenient.provider, strict.provider]).acceptsForcedToolChoiceFor?.('req')).toBe(
			false,
		)
		expect(strict.asked).toEqual([{ model: 'm1' }])
	})
})

describe('the effort travels through each decorator too', () => {
	it.each([
		['retry', (p: LLMProvider) => withProviderRetry(p)],
		['idle timeout', (p: LLMProvider) => withStreamIdleTimeout(p, { idleTimeoutMs: 1000 })],
		['fallback chain', (p: LLMProvider) => withProviderFallback([{ provider: p }])],
		['model window suffix', (p: LLMProvider) => withModelWindowSuffixStripped(p)],
	])('%s', (_name, wrap) => {
		const seen: Array<string | undefined> = []
		const base = driver('x', () => true).provider
		const provider: LLMProvider = {
			...base,
			acceptsForcedToolChoiceFor: (_m, _t, effort) => {
				seen.push(effort)
				return effort === 'none'
			},
		}
		const wrapped = wrap(provider)
		expect(wrapped.acceptsForcedToolChoiceFor?.('m', undefined, 'high')).toBe(false)
		expect(wrapped.acceptsForcedToolChoiceFor?.('m', undefined, 'none')).toBe(true)
		expect(seen).toEqual(['high', 'none'])
	})
})
