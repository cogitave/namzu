import { type LLMProvider, MockLLMProvider, type ModelInfo, withProviderFallback } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { modelReasoningView } from './model-reasoning.js'

function row(id: string, metadata: Partial<ModelInfo> = {}): ModelInfo {
	return {
		id,
		name: id,
		inputPrice: 0,
		outputPrice: 0,
		supportsToolUse: true,
		supportsStreaming: true,
		...metadata,
	}
}

describe('model-owned reasoning capability views', () => {
	it('uses an unseen exact model catalogue instead of stale driver defaults', () => {
		const provider: LLMProvider = Object.assign(new MockLLMProvider(), {
			reasoningEffortLevelsFor: () => ['low', 'high'] as const,
			reasoningEffortDefaultFor: () => 'low' as const,
		})
		const view = modelReasoningView(provider, 'future-model', [
			row('future-model', {
				reasoningEffortLevels: ['medium', 'ultra'],
				reasoningEffortDefault: 'ultra',
			}),
		])
		expect(view.reasoningEffortLevelsFor?.('future-model')).toEqual(['medium', 'ultra'])
		expect(view.reasoningEffortDefaultFor?.('future-model')).toBe('ultra')
		expect(view.reasoningEffortLevelsFor?.('other-model')).toBeUndefined()
	})

	it('retains per-model driver knowledge when listings omit effort metadata', () => {
		const provider: LLMProvider = Object.assign(new MockLLMProvider(), {
			reasoningEffortLevelsFor: (model: string) =>
				model === 'known' ? (['high'] as const) : undefined,
		})
		expect(
			modelReasoningView(provider, 'known', [row('known')]).reasoningEffortLevelsFor?.('known'),
		).toEqual(['high'])
		expect(
			modelReasoningView(provider, 'unknown', []).reasoningEffortLevelsFor?.('unknown'),
		).toBeUndefined()
	})

	it('distinguishes no support, malformed metadata and missing information', () => {
		const provider = new MockLLMProvider()
		expect(
			modelReasoningView(provider, 'plain', [
				row('plain', { reasoningEffortLevels: [] }),
			]).reasoningEffortLevelsFor?.('plain'),
		).toEqual([])
		for (const malformed of [['turbo'], ['high', 'high'], 'high']) {
			const metadata = { reasoningEffortLevels: malformed } as unknown as Partial<ModelInfo>
			expect(
				modelReasoningView(provider, 'bad', [row('bad', metadata)]).reasoningEffortLevelsFor?.(
					'bad',
				),
			).toBeUndefined()
		}
		expect(
			modelReasoningView(provider, 'missing', []).reasoningEffortLevelsFor?.('missing'),
		).toBeUndefined()
	})

	it('keeps menus when defaults are invalid or unavailable', () => {
		const provider = Object.assign(new MockLLMProvider(), {
			reasoningEffortDefaultFor: () => {
				throw new Error('unavailable')
			},
		})
		const view = modelReasoningView(provider, 'model', [
			row('model', { reasoningEffortLevels: ['low'] }),
		])
		expect(view.reasoningEffortLevelsFor?.('model')).toEqual(['low'])
		expect(view.reasoningEffortDefaultFor?.('model')).toBeUndefined()
		expect(
			modelReasoningView(provider, 'model', [
				row('model', { reasoningEffortLevels: ['low'], reasoningEffortDefault: 'high' }),
			]).reasoningEffortDefaultFor?.('model'),
		).toBe('high')
	})

	it('intersects exact route menus while rejecting an unknown fallback menu', () => {
		const provider = new MockLLMProvider()
		const first = modelReasoningView(provider, 'a', [
			row('a', { reasoningEffortLevels: ['low', 'high'] }),
		])
		const second = modelReasoningView(provider, 'b', [
			row('b', { reasoningEffortLevels: ['high', 'ultra'] }),
		])
		expect(
			withProviderFallback([
				{ provider: first, model: 'a' },
				{ provider: second, model: 'b' },
			]).reasoningEffortLevelsFor?.('a'),
		).toEqual(['high'])
		expect(
			withProviderFallback([
				{ provider: first, model: 'a' },
				{ provider: modelReasoningView(provider, 'b', []), model: 'b' },
			]).reasoningEffortLevelsFor?.('a'),
		).toBeUndefined()
	})
})
