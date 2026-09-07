import { describe, expect, it } from 'vitest'
import { type ZenService, findZenModel, getZenModels } from '../models.js'

describe('Zen model catalogue', () => {
	it('routes the same model through the documented service-specific protocol', () => {
		expect(findZenModel('zen', 'minimax-m3')?.protocol).toBe('chat')
		expect(findZenModel('go', 'minimax-m3')?.protocol).toBe('messages')
		expect(findZenModel('zen', 'minimax-m2.7')?.protocol).toBe('chat')
		expect(findZenModel('go', 'minimax-m2.7')?.protocol).toBe('messages')
		expect(findZenModel('zen', 'qwen3.6-plus')?.protocol).toBe('messages')
		expect(findZenModel('go', 'qwen3.6-plus')?.protocol).toBe('messages')
	})

	it('records native routes rather than routing all non-Claude models to chat', () => {
		expect(findZenModel('zen', 'claude-sonnet-5')?.protocol).toBe('messages')
		expect(findZenModel('zen', 'gpt-5.6-luna')?.protocol).toBe('responses')
		expect(findZenModel('go', 'gpt-5.6-luna')?.protocol).toBe('responses')
		expect(findZenModel('zen', 'grok-4.6')?.protocol).toBe('responses')
		expect(findZenModel('go', 'muse-spark-1.3-contributor')?.protocol).toBe('responses')
		expect(findZenModel('zen', 'gemini-3.8-flash')?.protocol).toBe('google')
		expect(findZenModel('go', 'gemini-3.8-flash')).toBeUndefined()
	})

	it.each(['zen', 'go'] as const)('keeps sourced default model metadata for %s', (service) => {
		expect(findZenModel(service, 'glm-5.3-flash')).toMatchObject({
			protocol: 'chat',
			contextWindow: 1_000_000,
			maxOutputTokens: 131_072,
			inputModalities: ['text', 'image', 'document'],
			inputPrice: 0.15,
			outputPrice: 0.5,
			supportsToolUse: true,
			supportsStreaming: true,
			effortLevels: ['low', 'high', 'max'],
		})
	})

	it('preserves service-specific serving limits and documented base-tier prices', () => {
		expect(findZenModel('zen', 'minimax-m3')?.contextWindow).toBe(512_000)
		expect(findZenModel('go', 'minimax-m3')?.contextWindow).toBe(1_000_000)
		expect(findZenModel('zen', 'deepseek-v4-pro')).toMatchObject({
			inputPrice: 1.74,
			outputPrice: 3.48,
		})
		expect(findZenModel('go', 'deepseek-v4-pro')).toMatchObject({
			inputPrice: 0.66,
			outputPrice: 1.98,
		})
	})

	it('distinguishes exact effort selectors from models with no effort selector', () => {
		expect(findZenModel('go', 'gpt-5.6-luna')?.effortLevels).toEqual([
			'none',
			'low',
			'medium',
			'high',
			'xhigh',
			'max',
		])
		expect(findZenModel('go', 'minimax-m3')?.effortLevels).toEqual([])
		expect(findZenModel('zen', 'gemini-3.8-flash')?.effortLevels).toEqual(['low', 'medium', 'high'])
	})

	it('does not infer future models, CLI prefixes, or deprecated model support', () => {
		for (const service of ['zen', 'go'] as const) {
			for (const id of [
				'claude-future',
				'gpt-future',
				'glm-future',
				'opencode/glm-5.3-flash',
				'opencode-go/glm-5.3-flash',
				'minimax-m2.5',
			]) {
				expect(findZenModel(service, id)).toBeUndefined()
			}
		}
	})

	it('includes documented promotional models with their actual zero price and native route', () => {
		for (const id of [
			'big-pickle',
			'mimo-v2.5-free',
			'ling-3.0-flash-fin-free',
			'nemotron-3-ultra-free',
			'nemotron-3.5-lightning-free',
		]) {
			expect(findZenModel('zen', id)).toMatchObject({
				protocol: 'chat',
				inputPrice: 0,
				outputPrice: 0,
			})
		}
		expect(findZenModel('zen', 'muse-spark-1.3-contributor-free')).toMatchObject({
			protocol: 'responses',
			inputPrice: 0,
			outputPrice: 0,
		})
	})

	it.each(['zen', 'go'] satisfies ZenService[])(
		'keeps %s catalogue entries immutable, distinct, and usable as cost estimates',
		(service) => {
			const models = getZenModels(service)
			expect(models.length).toBeGreaterThan(0)
			expect(new Set(models.map(({ id }) => id)).size).toBe(models.length)
			expect(Object.isFrozen(models)).toBe(true)
			for (const model of models) {
				expect(Object.isFrozen(model)).toBe(true)
				expect(Object.isFrozen(model.inputModalities)).toBe(true)
				expect(Object.isFrozen(model.effortLevels)).toBe(true)
				expect(Number.isFinite(model.inputPrice)).toBe(true)
				expect(Number.isFinite(model.outputPrice)).toBe(true)
				expect(model.inputPrice).toBeGreaterThanOrEqual(0)
				expect(model.outputPrice).toBeGreaterThanOrEqual(0)
				if (model.contextWindow !== undefined) expect(model.contextWindow).toBeGreaterThan(0)
				if (model.maxOutputTokens !== undefined) expect(model.maxOutputTokens).toBeGreaterThan(0)
			}
		},
	)
})
