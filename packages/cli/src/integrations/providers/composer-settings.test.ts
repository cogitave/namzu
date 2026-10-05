import { MockLLMProvider, type ModelInfo, type ReasoningEffort } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'
import { resolveProviderReasoning, validateComposerSendSettings } from './composer-settings.js'

function provider(menu?: readonly ReasoningEffort[], defaultEffort?: ReasoningEffort) {
	return Object.assign(new MockLLMProvider(), {
		reasoningEffortLevelsFor: () => menu,
		reasoningEffortDefaultFor: () => defaultEffort,
	})
}

describe('composer settings use the executing provider chain', () => {
	it('offers only effort levels accepted by every usable fallback', async () => {
		const primary = provider(['low', 'high'], 'low')
		const fallback = provider(['high', 'ultra'], 'high')
		expect(
			await resolveProviderReasoning([
				{ provider: primary, model: 'main' },
				{ provider: fallback, model: 'backup' },
			]),
		).toMatchObject({ effortLevels: ['high'] })
	})

	it('distinguishes unknown and explicitly unsupported fallback menus', async () => {
		const primary = provider(['high'])
		expect(
			(
				await resolveProviderReasoning([
					{ provider: primary, model: 'main' },
					{ provider: provider(), model: 'unknown' },
				])
			).effortLevels,
		).toBeUndefined()
		expect(
			(
				await resolveProviderReasoning([
					{ provider: primary, model: 'main' },
					{ provider: provider([]), model: 'plain' },
				])
			).effortLevels,
		).toEqual([])
	})

	it('discovers an exact unseen model without a model request', async () => {
		const selected = provider()
		const listModels = vi.fn(
			async (): Promise<ModelInfo[]> => [
				{
					id: 'new-model',
					name: 'New model',
					supportsToolUse: true,
					supportsStreaming: true,
					reasoningEffortLevels: ['medium', 'ultra'],
					reasoningEffortDefault: 'ultra',
				},
			],
		)
		Object.assign(selected, { listModels })
		const chat = vi.spyOn(selected, 'chatStream')
		expect(await resolveProviderReasoning([{ provider: selected, model: 'new-model' }])).toEqual({
			effortLevels: ['medium', 'ultra'],
			effortDefault: 'ultra',
		})
		expect(listModels).toHaveBeenCalledOnce()
		expect(chat).not.toHaveBeenCalled()
	})

	it('does not fetch another catalogue for an exact known empty menu', async () => {
		const selected = Object.assign(provider([]), { listModels: vi.fn(async () => []) })
		expect(
			(await resolveProviderReasoning([{ provider: selected, model: 'plain' }])).effortLevels,
		).toEqual([])
		expect(selected.listModels).not.toHaveBeenCalled()
	})

	it('keeps a known menu when the published default is outside it', async () => {
		const result = await resolveProviderReasoning([
			{ provider: provider(['low'], 'high'), model: 'main' },
		])
		expect(result.effortLevels).toEqual(['low'])
		expect(result.effortDefault).toBeUndefined()
		expect(result.notice).toContain('outside its exact menu')
	})

	it('cancels a pending catalogue operation without replacing it with unknown metadata', async () => {
		const controller = new AbortController()
		let enter = () => {}
		const entered = new Promise<void>((resolve) => {
			enter = resolve
		})
		const selected = Object.assign(provider(), {
			listModels: async () => {
				enter()
				return await new Promise<ModelInfo[]>(() => {})
			},
		})
		const operation = resolveProviderReasoning(
			[{ provider: selected, model: 'main' }],
			controller.signal,
		)
		await entered
		controller.abort(new Error('The conversation changed.'))
		await expect(operation).rejects.toThrow('The conversation changed.')
	})
})

describe('composer send settings validate the session at admission', () => {
	it('defaults to asking and preserves every real permission mode', () => {
		expect(validateComposerSendSettings(undefined, {})).toEqual({ permissionMode: 'prompt' })
		for (const permissionMode of ['prompt', 'accept-edits', 'auto', 'strict', 'plan']) {
			expect(validateComposerSendSettings({ permissionMode }, {})).toEqual({ permissionMode })
		}
	})
	it('uses the validated host default for omitted modes and retains explicit narrowing', () => {
		expect(validateComposerSendSettings(undefined, {}, 'auto')).toEqual({ permissionMode: 'auto' })
		expect(
			validateComposerSendSettings({ effort: 'high' }, { reasoningEffortLevels: ['high'] }, 'auto'),
		).toEqual({ permissionMode: 'auto', effort: 'high' })
		for (const permissionMode of ['prompt', 'accept-edits', 'strict', 'plan'] as const)
			expect(validateComposerSendSettings({ permissionMode }, {}, 'auto')).toEqual({
				permissionMode,
			})
	})

	it('rejects unsupported effort on a changed, unknown or unsupported route', () => {
		for (const session of [
			{},
			{ reasoningEffortLevels: [] },
			{ reasoningEffortLevels: ['low'] as const },
		]) {
			expect(() => validateComposerSendSettings({ effort: 'ultra' }, session)).toThrow(
				'not available',
			)
		}
		expect(
			validateComposerSendSettings(
				{ effort: 'high', permissionMode: 'plan' },
				{
					reasoningEffortLevels: ['low', 'high'],
				},
			),
		).toEqual({ effort: 'high', permissionMode: 'plan' })
	})

	it('rejects invented permission modes and malformed settings', () => {
		for (const value of [
			null,
			[],
			'auto',
			{ permissionMode: 'full-access' },
			{ permissionMode: 'edit' },
		]) {
			expect(() => validateComposerSendSettings(value, {})).toThrow()
		}
	})
})
