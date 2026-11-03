import { describe, expect, it } from 'vitest'

import type { LLMProvider, ReasoningEffort } from '../../../../types/provider/index.js'
import { effortForModel } from '../effort-clamp.js'

const provider = (menu: readonly ReasoningEffort[] | undefined) =>
	({ reasoningEffortLevelsFor: () => menu }) as unknown as LLMProvider

describe('effortForModel', () => {
	it('keeps a level the model offers', () => {
		expect(effortForModel(provider(['low', 'high', 'max']), 'm', 'high')).toBe('high')
	})

	it('goes to the next level down when the model lacks the requested one', () => {
		expect(effortForModel(provider(['low', 'high', 'max']), 'm', 'xhigh')).toBe('high')
		expect(effortForModel(provider(['low', 'high']), 'm', 'max')).toBe('high')
	})

	it('goes to the lowest level above when nothing offered is lower', () => {
		expect(effortForModel(provider(['high', 'max']), 'm', 'low')).toBe('high')
	})

	it('leaves the effort alone when the provider cannot say', () => {
		expect(effortForModel(provider(undefined), 'm', 'xhigh')).toBe('xhigh')
		expect(effortForModel(provider([]), 'm', 'xhigh')).toBe('xhigh')
		expect(effortForModel({} as LLMProvider, 'm', 'xhigh')).toBe('xhigh')
	})

	it('falls back to the legacy menu', () => {
		const legacy = { effortLevelsFor: () => ['low', 'medium'] } as unknown as LLMProvider
		expect(effortForModel(legacy, 'm', 'high')).toBe('medium')
	})
})
