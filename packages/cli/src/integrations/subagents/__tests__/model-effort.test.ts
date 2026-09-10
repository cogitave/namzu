import { MockLLMProvider, type ReasoningEffort } from '@namzu/sdk'
import { expect, it, vi } from 'vitest'
import { prepareDelegatedEffort } from '../model-effort.js'

it('loads an initially unknown effort menu on each fresh provider instance', async () => {
	for (let index = 0; index < 2; index++) {
		let ready = false
		const provider = Object.assign(new MockLLMProvider({ turns: [] }), {
			reasoningEffortLevelsFor: (_model: string): readonly ReasoningEffort[] | undefined =>
				ready ? ['low', 'high'] : undefined,
		})
		const list = vi.spyOn(provider, 'listModels').mockImplementation(async () => {
			ready = true
			return []
		})
		await prepareDelegatedEffort(provider, 'model')
		expect(provider.reasoningEffortLevelsFor('model')).toEqual(['low', 'high'])
		expect(list).toHaveBeenCalledTimes(1)
		await prepareDelegatedEffort(provider, 'model')
		expect(list).toHaveBeenCalledTimes(1)
	}
})
it('does not turn an explicitly unsupported menu into a discovery retry', async () => {
	const provider = Object.assign(new MockLLMProvider({ turns: [] }), {
		reasoningEffortLevelsFor: () => [],
	})
	const list = vi.spyOn(provider, 'listModels')
	await prepareDelegatedEffort(provider, 'model')
	expect(list).not.toHaveBeenCalled()
})
