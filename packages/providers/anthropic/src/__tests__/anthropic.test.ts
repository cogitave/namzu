import { DuplicateProviderError, ProviderRegistry } from '@namzu/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { AnthropicProvider } from '../client.js'
import { ANTHROPIC_CAPABILITIES, registerAnthropic } from '../index.js'

// Ensure a clean slate between tests. The sdk pre-registers 'mock' on import
// via its sideEffects whitelist; we only need to clear 'anthropic' to make
// re-registration deterministic across tests.
beforeEach(() => {
	if (ProviderRegistry.isSupported('anthropic')) {
		ProviderRegistry.unregister('anthropic')
	}
})

describe('@namzu/anthropic', () => {
	describe('registerAnthropic()', () => {
		it("adds 'anthropic' to the ProviderRegistry", () => {
			expect(ProviderRegistry.isSupported('anthropic')).toBe(false)
			registerAnthropic()
			expect(ProviderRegistry.isSupported('anthropic')).toBe(true)
			expect(ProviderRegistry.listTypes()).toContain('anthropic')
		})

		it('throws DuplicateProviderError when called twice without options', () => {
			registerAnthropic()
			expect(() => registerAnthropic()).toThrowError(DuplicateProviderError)
		})

		it('allows re-registration when { replace: true } is passed', () => {
			registerAnthropic()
			expect(() => registerAnthropic({ replace: true })).not.toThrow()
			expect(ProviderRegistry.isSupported('anthropic')).toBe(true)
		})

		it('exposes capabilities through the registry after registration', () => {
			registerAnthropic()
			const caps = ProviderRegistry.getCapabilities('anthropic')
			expect(caps).toEqual(ANTHROPIC_CAPABILITIES)
		})
	})

	describe('ANTHROPIC_CAPABILITIES', () => {
		it('declares the expected capability flags', () => {
			expect(ANTHROPIC_CAPABILITIES).toEqual({
				supportsTools: true,
				supportsStreaming: true,
				supportsFunctionCalling: true,
			})
		})
	})

	describe('AnthropicProvider', () => {
		it('constructs with an apiKey and exposes provider identity', () => {
			const provider = new AnthropicProvider({ apiKey: 'test-key' })
			expect(provider.id).toBe('anthropic')
			expect(provider.name).toBe('Anthropic')
		})

		it('throws when constructed without an apiKey', () => {
			expect(() => new AnthropicProvider({} as any)).toThrow(/apiKey is required/)
		})

		it('creates via ProviderRegistry.create with the registered type', () => {
			registerAnthropic()
			const { provider, capabilities } = ProviderRegistry.create({
				type: 'anthropic',
				apiKey: 'test-key',
				model: 'claude-sonnet-4-5-20250929',
			})
			expect(provider.id).toBe('anthropic')
			expect(capabilities).toEqual(ANTHROPIC_CAPABILITIES)
		})
	})
})
