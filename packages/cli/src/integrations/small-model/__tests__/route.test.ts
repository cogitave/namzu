import type { ModelInfo } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { cheapestTextModel, parseSmallModel } from '../route.js'

const model = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
	id,
	name: id,
	supportsToolUse: true,
	supportsStreaming: true,
	...extra,
})

describe('reading smallModel', () => {
	const known = (id: string) => id === 'anthropic' || id === 'openai'

	it('reads provider/model', () => {
		expect(parseSmallModel('anthropic/claude-haiku-4-5', 'zen', known)).toEqual({
			providerId: 'anthropic',
			model: 'claude-haiku-4-5',
		})
	})

	it('reads a bare id as a model of the active provider', () => {
		expect(parseSmallModel('gpt-5-mini', 'openai', known)).toEqual({
			providerId: 'openai',
			model: 'gpt-5-mini',
		})
	})

	it('reads a slash in a model id as part of the id when the first segment is no provider here', () => {
		expect(parseSmallModel('meta-llama/llama-3-8b', 'openrouter', known)).toEqual({
			providerId: 'openrouter',
			model: 'meta-llama/llama-3-8b',
		})
	})
})

describe('the cheapest text model', () => {
	it('takes the lowest input plus output price the listing states', () => {
		const picked = cheapestTextModel('acme', [
			model('big', { inputPrice: 10, outputPrice: 50 }),
			model('small', { inputPrice: 0.25, outputPrice: 1.25 }),
			model('mid', { inputPrice: 3, outputPrice: 15 }),
		])
		expect(picked?.id).toBe('small')
	})

	it('never picks a model whose price nobody states', () => {
		const picked = cheapestTextModel('acme', [
			model('unpriced'),
			model('half', { inputPrice: 0 }),
			model('priced', { inputPrice: 5, outputPrice: 20 }),
		])
		expect(picked?.id).toBe('priced')
	})

	it('answers nothing when no model states a price', () => {
		expect(cheapestTextModel('acme', [model('a'), model('b')])).toBeUndefined()
	})

	it('prices from the in-tree catalogue when the listing carries no price', () => {
		const picked = cheapestTextModel('anthropic', [
			model('claude-fable-5'),
			model('claude-haiku-4-5'),
		])
		expect(picked?.id).toBe('claude-haiku-4-5')
	})

	it('treats a free model as the cheapest', () => {
		const picked = cheapestTextModel('zen', [
			model('paid', { inputPrice: 1, outputPrice: 4 }),
			model('free', { inputPrice: 0, outputPrice: 0 }),
		])
		expect(picked?.id).toBe('free')
	})

	it('skips models that cannot stream, take no text, or are not chat models', () => {
		const picked = cheapestTextModel('acme', [
			model('no-stream', {
				inputPrice: 0.1,
				outputPrice: 0.1,
				supportsStreaming: false,
			}),
			model('image-only', {
				inputPrice: 0.1,
				outputPrice: 0.1,
				inputModalities: ['image'],
			}),
			model('text-embedding-3', { inputPrice: 0.01, outputPrice: 0 }),
			model('chat', { inputPrice: 1, outputPrice: 1 }),
		])
		expect(picked?.id).toBe('chat')
	})

	it('skips what the picker would not offer', () => {
		const picked = cheapestTextModel(
			'acme',
			[
				model('hidden', { inputPrice: 0, outputPrice: 0 }),
				model('shown', { inputPrice: 1, outputPrice: 1 }),
			],
			(candidate) => candidate.id !== 'hidden',
		)
		expect(picked?.id).toBe('shown')
	})

	it('breaks a tie by the larger context window, then the shorter id', () => {
		const tied = [
			model('aaa-long-name', {
				inputPrice: 1,
				outputPrice: 1,
				contextWindow: 8000,
			}),
			model('bbb', { inputPrice: 1, outputPrice: 1, contextWindow: 128000 }),
			model('cc', { inputPrice: 1, outputPrice: 1, contextWindow: 128000 }),
		]
		expect(cheapestTextModel('acme', tied)?.id).toBe('cc')
	})
})
