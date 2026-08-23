import { attributionHeaders } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { AnthropicProvider } from '../client.js'

/**
 * The OAuth branch's user-agent is authentication, not labelling.
 *
 * `claude-code/<version> (external, cli)` and `x-app: cli` signals are there
 * because the Messages endpoint routes subscription tokens by this identity.
 * Merging
 * attribution into that branch would not improve the label — it would
 * break the login, intermittently and with a 401 or a 500 that names none
 * of this.
 *
 * So NZ-PROV-04 touches the api-key branch only, and this file is the
 * thing standing between a future tidy-up and a broken auth path.
 */

/** The SDK client's default headers, which is where both branches land. */
function defaultHeaders(provider: AnthropicProvider): Record<string, string> {
	const client = (provider as unknown as { client: { _options?: { defaultHeaders?: unknown } } })
		.client
	return (client._options?.defaultHeaders ?? {}) as Record<string, string>
}

describe('attribution and the OAuth user-agent', () => {
	it('leaves the OAuth branch carrying the exact subscription-routing identity', () => {
		const provider = new AnthropicProvider({ authToken: 'oauth-token' })

		const headers = defaultHeaders(provider)

		expect(headers['anthropic-beta']).toBe('claude-code-20250219,oauth-2025-04-20')
		expect(headers['user-agent']).toMatch(/^claude-code\/\d+\.\d+\.\d+ \(external, cli\)$/)
		expect(headers['x-app']).toBe('cli')
		expect(headers['user-agent']).not.toContain('namzu/')
	})

	it('labels the api-key branch, which has no such constraint', () => {
		const provider = new AnthropicProvider({ apiKey: 'sk-test' })

		expect(defaultHeaders(provider)['User-Agent']).toBe(attributionHeaders()['User-Agent'])
	})

	it("lets a host's own header win on the api-key branch", () => {
		// Merged, not assigned over. A host that customises its transport
		// keeps the final word — and must not silently lose attribution
		// either, which assigning `config.defaultHeaders` straight over did.
		const provider = new AnthropicProvider({
			apiKey: 'sk-test',
			defaultHeaders: { 'X-Host': 'mine' },
		})

		const headers = defaultHeaders(provider)

		expect(headers['X-Host']).toBe('mine')
		expect(headers['User-Agent']).toBe(attributionHeaders()['User-Agent'])
	})
})
