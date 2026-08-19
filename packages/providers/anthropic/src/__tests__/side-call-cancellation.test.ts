import { describe, expect, it, vi } from 'vitest'

import { AnthropicProvider } from '../client.js'

describe('provider side-call cancellation', () => {
	it('passes the caller signal to both model operations', async () => {
		const list = vi.fn(async () => ({ data: [] }))
		const provider = new AnthropicProvider({ apiKey: 'test-key' })
		;(provider as unknown as { client: { models: { list: typeof list } } }).client = {
			models: { list },
		}
		const controller = new AbortController()

		await provider.listModels(controller.signal)
		await provider.probeCredential(controller.signal)

		expect(list).toHaveBeenNthCalledWith(1, { limit: 100 }, { signal: controller.signal })
		expect(list).toHaveBeenNthCalledWith(2, { limit: 1 }, { signal: controller.signal })
	})
})
