import { describe, expect, it, vi } from 'vitest'

import { OllamaProvider } from '../client.js'

describe('provider side-call cancellation', () => {
	it('refuses to publish a vendor result after the caller aborts', async () => {
		let release: (value: { models: [] }) => void = () => {}
		const pending = new Promise<{ models: [] }>((resolve) => {
			release = resolve
		})
		const list = vi.fn(() => pending)
		const provider = new OllamaProvider()
		;(provider as unknown as { client: { list: typeof list } }).client = { list }
		const controller = new AbortController()
		const cause = new Error('picker was left')

		const listing = provider.listModels(controller.signal)
		controller.abort(cause)
		release({ models: [] })

		await expect(listing).rejects.toBe(cause)
	})
})
