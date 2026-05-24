import { describe, expect, it } from 'vitest'

import { isAnthropicOAuthToken } from './keychain.js'

describe('isAnthropicOAuthToken', () => {
	it('detects Claude Code OAuth tokens (cc- prefix)', () => {
		expect(isAnthropicOAuthToken('cc-some-opaque-id')).toBe(true)
	})

	it('detects Anthropic setup OAuth tokens (sk-ant-oat- prefix)', () => {
		expect(isAnthropicOAuthToken('sk-ant-oat01-...')).toBe(true)
	})

	it('detects JWT-shaped tokens (eyJ prefix)', () => {
		expect(isAnthropicOAuthToken('eyJhbGciOiJIUzI1NiIs...')).toBe(true)
	})

	it('rejects console API keys (sk-ant-api*)', () => {
		expect(isAnthropicOAuthToken('sk-ant-api03-deadbeef')).toBe(false)
	})

	it('defaults to false (API-key path) for unknown shapes', () => {
		expect(isAnthropicOAuthToken('arbitrary-string')).toBe(false)
		expect(isAnthropicOAuthToken('')).toBe(false)
	})
})
