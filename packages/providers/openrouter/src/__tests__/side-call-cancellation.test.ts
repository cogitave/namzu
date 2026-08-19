import { afterEach, describe, expect, it, vi } from 'vitest'

import { OpenRouterProvider } from '../client.js'

afterEach(() => vi.unstubAllGlobals())

describe('provider side-call cancellation', () => {
	it('passes the caller signal to both HTTP operations', async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => ({
			ok: true,
			status: 200,
			json: async () => (String(input).endsWith('/models') ? { data: [] } : {}),
		}))
		vi.stubGlobal('fetch', fetchMock)
		const provider = new OpenRouterProvider({
			apiKey: 'test-key',
			baseUrl: 'https://example.test/api/v1',
		})
		const controller = new AbortController()

		await provider.listModels(controller.signal)
		await provider.probeCredential(controller.signal)

		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal })
		expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ signal: controller.signal })
	})
})
