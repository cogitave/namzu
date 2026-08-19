/** Every provider decorator preserves cancellation on non-chat side calls. */

import { describe, expect, it, vi } from 'vitest'

import type { LLMProvider } from '../../types/provider/interface.js'
import { withProviderFallback } from '../fallback.js'
import { withStreamIdleTimeout } from '../idle-timeout.js'
import { wrapProviderWithProbes } from '../instrumentation.js'
import { withProviderRetry } from '../retry.js'

function inert(id: string): LLMProvider {
	return {
		id,
		name: id,
		chatStream: async function* () {},
	}
}

const wrappers: ReadonlyArray<{
	name: string
	wrap(provider: LLMProvider): LLMProvider
}> = [
	{ name: 'retry', wrap: (provider) => withProviderRetry(provider) },
	{
		name: 'fallback',
		wrap: (provider) => withProviderFallback([{ provider }, { provider: inert('fallback') }]),
	},
	{
		name: 'idle timeout',
		wrap: (provider) => withStreamIdleTimeout(provider, { idleTimeoutMs: 1_000 }),
	},
	{ name: 'instrumentation', wrap: (provider) => wrapProviderWithProbes(provider) },
]

describe.each(wrappers)('$name provider wrapper', ({ wrap }) => {
	it('forwards the exact signal to model listing and credential probing', async () => {
		const listModels = vi.fn(async (_signal?: AbortSignal) => [])
		const probeCredential = vi.fn(async (_signal?: AbortSignal) => {})
		const provider: LLMProvider = {
			...inert('primary'),
			listModels,
			probeCredential,
		}
		const wrapped = wrap(provider)
		const controller = new AbortController()

		await wrapped.listModels?.(controller.signal)
		await wrapped.probeCredential?.(controller.signal)

		expect(listModels).toHaveBeenCalledOnce()
		expect(listModels).toHaveBeenCalledWith(controller.signal)
		expect(probeCredential).toHaveBeenCalledOnce()
		expect(probeCredential).toHaveBeenCalledWith(controller.signal)
	})
})
