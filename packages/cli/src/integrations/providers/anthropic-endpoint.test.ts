import { describe, expect, it } from 'vitest'
import {
	readAnthropicEndpoint,
	resolveAnthropicEndpoint,
	thirdPartyHost,
} from './anthropic-endpoint.js'

describe('ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN', () => {
	it('are absent by default', () => {
		expect(readAnthropicEndpoint({})).toBeUndefined()
		expect(thirdPartyHost({})).toBeUndefined()
	})
	it('name a third-party endpoint, its host and its bearer token', () => {
		const env = {
			ANTHROPIC_BASE_URL: 'https://api.example.test/anthropic',
			ANTHROPIC_AUTH_TOKEN: ' tok ',
		}
		expect(readAnthropicEndpoint(env)).toEqual({
			baseURL: 'https://api.example.test/anthropic',
			host: 'api.example.test',
			vendor: false,
			authToken: 'tok',
		})
		expect(thirdPartyHost(env)).toBe('api.example.test')
	})
	it('treat the vendor host as the vendor, and show no host for it', () => {
		const env = { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }
		expect(readAnthropicEndpoint(env)?.vendor).toBe(true)
		expect(thirdPartyHost(env)).toBeUndefined()
	})
	it('refuses a value that is not a URL rather than falling back to the vendor', () => {
		expect(() => readAnthropicEndpoint({ ANTHROPIC_BASE_URL: 'api.example.test' })).toThrow(
			'ANTHROPIC_BASE_URL',
		)
		expect(() => readAnthropicEndpoint({ ANTHROPIC_BASE_URL: 'ftp://x.test' })).toThrow(
			'ANTHROPIC_BASE_URL',
		)
		expect(thirdPartyHost({ ANTHROPIC_BASE_URL: 'nonsense' })).toBeUndefined()
	})
})

describe('resolveAnthropicEndpoint', () => {
	it('ignores a third-party base URL with no credential variable, and says so', () => {
		const out = resolveAnthropicEndpoint({ ANTHROPIC_BASE_URL: 'https://api.example.test/x' })
		expect(out.endpoint).toBeUndefined()
		expect(out.notice).toContain('api.example.test')
		expect(thirdPartyHost({ ANTHROPIC_BASE_URL: 'https://api.example.test/x' })).toBeUndefined()
	})
	it('ignores a base URL that is not a URL, with a notice instead of a throw', () => {
		const out = resolveAnthropicEndpoint({ ANTHROPIC_BASE_URL: 'api.example.test' })
		expect(out.endpoint).toBeUndefined()
		expect(out.notice).toContain('ANTHROPIC_BASE_URL')
	})
	it('uses a third-party base URL once a token or key is set', () => {
		const out = resolveAnthropicEndpoint({
			ANTHROPIC_BASE_URL: 'https://api.example.test/x',
			ANTHROPIC_API_KEY: 'k',
		})
		expect(out.endpoint?.apiKey).toBe('k')
		expect(out.notice).toBeUndefined()
	})
})
