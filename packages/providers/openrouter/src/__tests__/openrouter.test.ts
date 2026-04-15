import { DuplicateProviderError, ProviderRegistry } from '@namzu/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { OPENROUTER_CAPABILITIES, OpenRouterProvider, registerOpenRouter } from '../index.js'

// Ensure a clean slate between tests. The sdk pre-registers 'mock' on import
// via its sideEffects whitelist; we only need to clear 'openrouter' to make
// re-registration deterministic across tests.
beforeEach(() => {
	if (ProviderRegistry.isSupported('openrouter')) {
		ProviderRegistry.unregister('openrouter')
	}
})

describe('@namzu/openrouter', () => {
	describe('registerOpenRouter()', () => {
		it("adds 'openrouter' to the ProviderRegistry", () => {
			expect(ProviderRegistry.isSupported('openrouter')).toBe(false)
			registerOpenRouter()
			expect(ProviderRegistry.isSupported('openrouter')).toBe(true)
			expect(ProviderRegistry.listTypes()).toContain('openrouter')
		})

		it('throws DuplicateProviderError when called twice without options', () => {
			registerOpenRouter()
			expect(() => registerOpenRouter()).toThrowError(DuplicateProviderError)
		})

		it('allows re-registration when { replace: true } is passed', () => {
			registerOpenRouter()
			expect(() => registerOpenRouter({ replace: true })).not.toThrow()
			expect(ProviderRegistry.isSupported('openrouter')).toBe(true)
		})

		it('exposes capabilities through the registry after registration', () => {
			registerOpenRouter()
			const caps = ProviderRegistry.getCapabilities('openrouter')
			expect(caps).toEqual(OPENROUTER_CAPABILITIES)
		})
	})

	describe('OPENROUTER_CAPABILITIES', () => {
		it('declares the expected capability flags', () => {
			expect(OPENROUTER_CAPABILITIES).toEqual({
				supportsTools: true,
				supportsStreaming: true,
				supportsFunctionCalling: true,
			})
		})
	})

	describe('ProviderRegistry.create({ type: "openrouter", ... })', () => {
		it('narrows the config type via module augmentation and instantiates OpenRouterProvider', () => {
			registerOpenRouter()
			const { provider, capabilities } = ProviderRegistry.create({
				type: 'openrouter',
				apiKey: 'test-key',
				siteUrl: 'https://example.com',
				siteName: 'Test',
			})
			expect(provider).toBeInstanceOf(OpenRouterProvider)
			expect(capabilities).toEqual(OPENROUTER_CAPABILITIES)
		})
	})
})
