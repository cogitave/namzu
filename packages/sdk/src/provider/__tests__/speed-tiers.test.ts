import { describe, expect, expectTypeOf, it } from 'vitest'

import type {
	ChatCompletionParams,
	InferenceSpeed,
	LLMProvider,
	ModelInfo,
} from '../../types/provider/index.js'
import { withProviderFallback } from '../fallback.js'
import { withStreamIdleTimeout } from '../idle-timeout.js'
import { withModelWindowSuffixStripped } from '../model-window-suffix.js'
import { withProviderRetry } from '../retry.js'

function driver(
	id: string,
	speedTiersFor?: (model: string) => readonly ('fast' | 'ultrafast')[] | undefined,
): LLMProvider {
	return {
		id,
		name: id,
		chat: async () => {
			throw new Error('unused')
		},
		chatStream: async function* () {},
		...(speedTiersFor ? { speedTiersFor } : {}),
	} as unknown as LLMProvider
}

const tiers = (model: string) => (model === 'listed' ? (['fast', 'ultrafast'] as const) : undefined)

describe('the speed tiers a model offers', () => {
	it('is a three-member speed and an optional listing field', () => {
		expectTypeOf<InferenceSpeed>().toEqualTypeOf<'standard' | 'fast' | 'ultrafast'>()
		expectTypeOf<ModelInfo['speedTiers']>().toEqualTypeOf<
			readonly ('fast' | 'ultrafast')[] | undefined
		>()
		expectTypeOf<ChatCompletionParams['speed']>().toEqualTypeOf<InferenceSpeed | undefined>()
	})

	it('is forwarded by the retry and idle-timeout wrappers, and only when the driver has it', () => {
		const withTiers = driver('d', tiers)
		expect(
			withProviderRetry(withTiers, { config: { maxRetries: 1 } }).speedTiersFor?.('listed'),
		).toEqual(['fast', 'ultrafast'])
		expect(
			withStreamIdleTimeout(withTiers, { idleTimeoutMs: 1_000 }).speedTiersFor?.('x'),
		).toBeUndefined()
		expect(
			withProviderRetry(driver('plain'), { config: { maxRetries: 1 } }).speedTiersFor,
		).toBeUndefined()
	})

	it('is asked with the bare model id, without the window marker', () => {
		const asked: string[] = []
		const wrapped = withModelWindowSuffixStripped(
			driver('d', (model) => {
				asked.push(model)
				return ['fast']
			}),
		)
		expect(wrapped.speedTiersFor?.('listed[1m]')).toEqual(['fast'])
		expect(asked).toEqual(['listed'])
	})

	it('is published by a fallback chain only as the tiers every member offers', () => {
		const head = driver('head', () => ['fast', 'ultrafast'])
		const tail = driver('tail', () => ['fast'])
		expect(
			withProviderFallback([{ provider: head }, { provider: tail }]).speedTiersFor?.('m'),
		).toEqual(['fast'])
		expect(
			withProviderFallback([{ provider: head }, { provider: driver('silent') }]).speedTiersFor?.(
				'm',
			),
		).toBeUndefined()
	})
})
