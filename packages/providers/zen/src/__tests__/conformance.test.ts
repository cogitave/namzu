import { collectChatCompletion } from '@namzu/sdk'
import { defineProviderDriverConformance } from '@namzu/sdk/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZenGoProvider, ZenProvider } from '../client.js'

const drivers = [
	{
		registryType: 'zen',
		baseURL: 'https://opencode.ai/zen/v1',
		makeProvider: () =>
			new ZenProvider({ apiKey: 'conformance-key', sessionId: 'conformance-session' }),
	},
	{
		registryType: 'zen-go',
		baseURL: 'https://opencode.ai/zen/go/v1',
		makeProvider: () =>
			new ZenGoProvider({ apiKey: 'conformance-key', sessionId: 'conformance-session' }),
	},
]

// Both registrations run the shared SDK contract against fresh real drivers.
// The four native dialects and rich-content limitations have separate wire tests.
for (const driver of drivers) {
	defineProviderDriverConformance({
		describe,
		it,
		expect,
		label: driver.registryType,
		registryType: driver.registryType,
		retryDefaults: undefined,
		attribution: { kind: 'header' },
		makeProvider: driver.makeProvider,
	})
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('Zen provider attribution on the HTTP transport', () => {
	it.each(drivers)(
		'$registryType sends Namzu attribution and its stable conversation ID',
		async (driver) => {
			const fetchMock = vi.fn<typeof fetch>(
				async () =>
					new Response(
						[
							'data: {"id":"conformance-1","choices":[{"index":0,"delta":{"role":"assistant","content":"Ready."},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
							'data: [DONE]',
							'',
						].join('\n\n'),
						{ headers: { 'content-type': 'text/event-stream' } },
					),
			)
			vi.stubGlobal('fetch', fetchMock)
			const provider = driver.makeProvider()
			const completion = await collectChatCompletion(
				provider.chatStream({
					model: 'glm-5.3-flash',
					messages: [{ role: 'user', content: 'Ready?' }],
				}),
			)
			expect(completion.message.content).toBe('Ready.')
			expect(completion.finishReason).toBe('stop')
			expect(fetchMock).toHaveBeenCalledTimes(1)
			const request = fetchMock.mock.calls[0]
			if (!request) throw new Error('Expected an HTTP request')
			const [url, init] = request
			expect(url).toBe(`${driver.baseURL}/chat/completions`)
			const headers = new Headers(init?.headers)
			expect(headers.get('user-agent')).toMatch(/^namzu\//)
			expect(headers.get('x-opencode-session')).toBe('conformance-session')
			expect(headers.get('authorization')).toBe('Bearer conformance-key')
		},
	)
})
