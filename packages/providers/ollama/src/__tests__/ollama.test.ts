import { DuplicateProviderError, ProviderRegistry } from '@namzu/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { OLLAMA_CAPABILITIES, registerOllama } from '../index.js'

// Ensure a clean slate between tests. The sdk pre-registers 'mock' on import
// via its sideEffects whitelist; we only need to clear 'ollama' to make
// re-registration deterministic across tests.
beforeEach(() => {
	if (ProviderRegistry.isSupported('ollama')) {
		ProviderRegistry.unregister('ollama')
	}
})

describe('@namzu/ollama', () => {
	describe('registerOllama()', () => {
		it("adds 'ollama' to the ProviderRegistry", () => {
			expect(ProviderRegistry.isSupported('ollama')).toBe(false)
			registerOllama()
			expect(ProviderRegistry.isSupported('ollama')).toBe(true)
			expect(ProviderRegistry.listTypes()).toContain('ollama')
		})

		it('throws DuplicateProviderError when called twice without options', () => {
			registerOllama()
			expect(() => registerOllama()).toThrowError(DuplicateProviderError)
		})

		it('allows re-registration when { replace: true } is passed', () => {
			registerOllama()
			expect(() => registerOllama({ replace: true })).not.toThrow()
			expect(ProviderRegistry.isSupported('ollama')).toBe(true)
		})

		it('exposes capabilities through the registry after registration', () => {
			registerOllama()
			const caps = ProviderRegistry.getCapabilities('ollama')
			expect(caps).toEqual(OLLAMA_CAPABILITIES)
		})
	})

	describe('OLLAMA_CAPABILITIES', () => {
		it('declares the expected capability flags', () => {
			expect(OLLAMA_CAPABILITIES).toEqual({
				supportsTools: false,
				supportsStreaming: true,
				supportsFunctionCalling: false,
			})
		})
	})
})
