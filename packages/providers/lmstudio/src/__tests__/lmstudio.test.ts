import { DuplicateProviderError, ProviderRegistry } from '@namzu/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { LMSTUDIO_CAPABILITIES, registerLMStudio } from '../index.js'

// Ensure a clean slate between tests. The sdk pre-registers 'mock' on import
// via its sideEffects whitelist; we only need to clear 'lmstudio' to make
// re-registration deterministic across tests.
beforeEach(() => {
	if (ProviderRegistry.isSupported('lmstudio')) {
		ProviderRegistry.unregister('lmstudio')
	}
})

describe('@namzu/lmstudio', () => {
	describe('registerLMStudio()', () => {
		it("adds 'lmstudio' to the ProviderRegistry", () => {
			expect(ProviderRegistry.isSupported('lmstudio')).toBe(false)
			registerLMStudio()
			expect(ProviderRegistry.isSupported('lmstudio')).toBe(true)
			expect(ProviderRegistry.listTypes()).toContain('lmstudio')
		})

		it('throws DuplicateProviderError when called twice without options', () => {
			registerLMStudio()
			expect(() => registerLMStudio()).toThrowError(DuplicateProviderError)
		})

		it('allows re-registration when { replace: true } is passed', () => {
			registerLMStudio()
			expect(() => registerLMStudio({ replace: true })).not.toThrow()
			expect(ProviderRegistry.isSupported('lmstudio')).toBe(true)
		})

		it('exposes capabilities through the registry after registration', () => {
			registerLMStudio()
			const caps = ProviderRegistry.getCapabilities('lmstudio')
			expect(caps).toEqual(LMSTUDIO_CAPABILITIES)
		})
	})

	describe('LMSTUDIO_CAPABILITIES', () => {
		it('declares the expected capability flags', () => {
			expect(LMSTUDIO_CAPABILITIES).toEqual({
				supportsTools: true,
				supportsStreaming: true,
				supportsFunctionCalling: true,
			})
		})
	})
})
