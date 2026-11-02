import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveModelPricing } from '../../pricing/index.js'
import { withModelWindowSuffixStripped } from '../../provider/model-window-suffix.js'
import type { LLMProvider } from '../../types/provider/interface.js'
import {
	lookupContextWindow,
	parseAutoCompactWindow,
	resolveAutoCompactWindowSetting,
	resolveContextWindow,
	resolveTriggerThreshold,
	splitModelWindowSuffix,
} from '../context-window.js'

afterEach(() => vi.unstubAllEnvs())

describe('the [1m] model-id suffix', () => {
	it('splits case-insensitively and only at the end', () => {
		expect(splitModelWindowSuffix('deepseek-flash[1m]')).toEqual({
			model: 'deepseek-flash',
			declaresOneMillion: true,
		})
		expect(splitModelWindowSuffix('x[1M]').declaresOneMillion).toBe(true)
		expect(splitModelWindowSuffix('x[1m]y')).toEqual({ model: 'x[1m]y', declaresOneMillion: false })
	})

	it('gives an unrecognised id a million-token window', () => {
		const resolved = resolveContextWindow(undefined, 'made-up-model[1m]')
		expect(resolved.tokens).toBe(1_000_000)
		// 1M window, 20k output reserve, 13k buffer: first summary at 967,000.
		expect(Math.floor(resolved.tokens * resolveTriggerThreshold(undefined, resolved.tokens))).toBe(
			967_000,
		)
		expect(resolveContextWindow(undefined, 'made-up-model').tokens).toBe(128_000)
	})

	it('raises a known smaller window and never lowers a larger one', () => {
		expect(lookupContextWindow('gpt-4o[1m]')).toBe(1_000_000)
		expect(lookupContextWindow('gemini-1.5-pro[1m]')).toBe(2_097_152)
		expect(resolveContextWindow(undefined, 'x[1m]', 2_000_000).tokens).toBe(2_000_000)
		expect(resolveContextWindow(undefined, 'x[1m]', 64_000).tokens).toBe(1_000_000)
	})

	it('yields to an explicit configured window', () => {
		expect(resolveContextWindow(300_000, 'x[1m]')).toEqual({ tokens: 300_000, source: 'config' })
	})

	it('declares nothing under NAMZU_DISABLE_1M_CONTEXT, and caps assumed windows at 200k', () => {
		vi.stubEnv('NAMZU_DISABLE_1M_CONTEXT', '1')
		expect(resolveContextWindow(undefined, 'made-up-model[1m]').tokens).toBe(128_000)
		expect(resolveContextWindow(undefined, 'deepseek-flash', 1_000_000).tokens).toBe(200_000)
		expect(resolveContextWindow(1_000_000, 'deepseek-flash').tokens).toBe(1_000_000)
	})

	it('is stripped before pricing and before any driver call', async () => {
		expect(resolveModelPricing('openai', 'gpt-4o[1m]')).toEqual(
			resolveModelPricing('openai', 'gpt-4o'),
		)
		const seen: unknown[] = []
		const inner = {
			id: 'x',
			name: 'x',
			chatStream: async function* (params: { model: string }) {
				seen.push(params.model)
			},
			resolveContextWindow: async (model: string) => {
				seen.push(model)
				return undefined
			},
			supportsImageInputFor: (model: string) => model === 'deepseek-flash',
		} as unknown as LLMProvider
		const wrapped = withModelWindowSuffixStripped(inner)
		for await (const _ of wrapped.chatStream({ model: 'deepseek-flash[1m]', messages: [] })) {
			// drained
		}
		await wrapped.resolveContextWindow?.('deepseek-flash[1M]')
		expect(seen).toEqual(['deepseek-flash', 'deepseek-flash'])
		expect(wrapped.supportsImageInputFor?.('deepseek-flash[1m]')).toBe(true)
		expect(wrapped.id).toBe('x')
	})
})

describe('the written auto-compact window', () => {
	it.each([
		['786432', 786_432],
		['200000', 200_000],
		['786k', 786_000],
		['200K', 200_000],
		['1m', 1_000_000],
		['1.5m', 'above'],
		['0.5m', 500_000],
		[' 300k ', 300_000],
	])('reads %s', (raw, tokens) => {
		const parsed = parseAutoCompactWindow(raw as string)
		if (tokens === 'above') expect(parsed.kind).toBe('above_maximum')
		else expect(parsed).toEqual({ kind: 'in_range', tokens })
	})

	it('clamps with a one-line warning that names the clamp', () => {
		const low = resolveAutoCompactWindowSetting('50k', 'NAMZU_AUTO_COMPACT_WINDOW')
		expect(low.tokens).toBe(100_000)
		expect(low.warning).toContain('100k minimum')
		expect(low.warning).not.toContain('\n')
		const high = resolveAutoCompactWindowSetting('5m', 'NAMZU_AUTO_COMPACT_WINDOW')
		expect(high.tokens).toBe(1_000_000)
		expect(high.warning).toContain('1M maximum')
		const bad = resolveAutoCompactWindowSetting('lots', 'NAMZU_AUTO_COMPACT_WINDOW')
		expect(bad.tokens).toBeUndefined()
		expect(bad.warning).toContain('ignores it')
		expect(resolveAutoCompactWindowSetting('786k', 'X').warning).toBeUndefined()
	})

	it('only lowers the model window: 786k on deepseek-flash, nothing on a smaller model', () => {
		const at = (window: number, written: number) =>
			Math.floor(window * resolveTriggerThreshold(undefined, window, 384_000, written))
		// 1M window, 786,432 written: window 786,432, reserve 20k + buffer 13k.
		expect(at(1_000_000, 786_432)).toBe(753_432)
		// A 64k model is not raised by the same setting.
		expect(at(64_000, 786_432)).toBe(at(64_000, 64_000))
	})
})
