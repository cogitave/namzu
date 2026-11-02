import { describe, expect, it } from 'vitest'
import { readAnthropicEndpoint, thirdPartyHost } from './anthropic-endpoint.js'

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
