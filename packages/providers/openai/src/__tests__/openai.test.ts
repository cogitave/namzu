import { DuplicateProviderError, ProviderRegistry } from '@namzu/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { OPENAI_CAPABILITIES, OpenAIProvider, registerOpenAI } from '../index.js'

// Ensure a clean slate between tests. The sdk pre-registers 'mock' on import
// via its sideEffects whitelist; we only need to clear 'openai' to make
// re-registration deterministic across tests.
beforeEach(() => {
	if (ProviderRegistry.isSupported('openai')) {
		ProviderRegistry.unregister('openai')
	}
})

describe('@namzu/openai', () => {
	describe('registerOpenAI()', () => {
		it("adds 'openai' to the ProviderRegistry", () => {
			expect(ProviderRegistry.isSupported('openai')).toBe(false)
			registerOpenAI()
			expect(ProviderRegistry.isSupported('openai')).toBe(true)
			expect(ProviderRegistry.listTypes()).toContain('openai')
		})

		it('throws DuplicateProviderError when called twice without options', () => {
			registerOpenAI()
			expect(() => registerOpenAI()).toThrowError(DuplicateProviderError)
		})

		it('allows re-registration when { replace: true } is passed', () => {
			registerOpenAI()
			expect(() => registerOpenAI({ replace: true })).not.toThrow()
			expect(ProviderRegistry.isSupported('openai')).toBe(true)
		})

		it('exposes capabilities through the registry after registration', () => {
			registerOpenAI()
			const caps = ProviderRegistry.getCapabilities('openai')
			expect(caps).toEqual(OPENAI_CAPABILITIES)
		})
	})

	describe('OPENAI_CAPABILITIES', () => {
		it('declares the expected capability flags', () => {
			expect(OPENAI_CAPABILITIES).toEqual({
				supportsTools: true,
				supportsStreaming: true,
				supportsFunctionCalling: true,
			})
		})
	})

	describe('ProviderRegistry.create({ type: "openai", ... })', () => {
		it('narrows the config type via module augmentation and instantiates OpenAIProvider', () => {
			registerOpenAI()
			const { provider, capabilities } = ProviderRegistry.create({
				type: 'openai',
				apiKey: 'test-key',
				model: 'gpt-4o-mini',
			})
			expect(provider).toBeInstanceOf(OpenAIProvider)
			expect(capabilities).toEqual(OPENAI_CAPABILITIES)
		})

		it('throws when apiKey is missing', () => {
			registerOpenAI()
			expect(() =>
				ProviderRegistry.create({
					type: 'openai',
					apiKey: '',
				}),
			).toThrowError(/API key is required/)
		})
	})
})
