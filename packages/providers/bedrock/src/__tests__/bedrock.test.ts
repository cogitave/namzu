import { DuplicateProviderError, ProviderRegistry } from '@namzu/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { BEDROCK_CAPABILITIES, registerBedrock } from '../index.js'

// Ensure a clean slate between tests. The sdk pre-registers 'mock' on import
// via its sideEffects whitelist; we only need to clear 'bedrock' to make
// re-registration deterministic across tests.
beforeEach(() => {
	if (ProviderRegistry.isSupported('bedrock')) {
		ProviderRegistry.unregister('bedrock')
	}
})

describe('@namzu/bedrock', () => {
	describe('registerBedrock()', () => {
		it("adds 'bedrock' to the ProviderRegistry", () => {
			expect(ProviderRegistry.isSupported('bedrock')).toBe(false)
			registerBedrock()
			expect(ProviderRegistry.isSupported('bedrock')).toBe(true)
			expect(ProviderRegistry.listTypes()).toContain('bedrock')
		})

		it('throws DuplicateProviderError when called twice without options', () => {
			registerBedrock()
			expect(() => registerBedrock()).toThrowError(DuplicateProviderError)
		})

		it('allows re-registration when { replace: true } is passed', () => {
			registerBedrock()
			expect(() => registerBedrock({ replace: true })).not.toThrow()
			expect(ProviderRegistry.isSupported('bedrock')).toBe(true)
		})

		it('exposes capabilities through the registry after registration', () => {
			registerBedrock()
			const caps = ProviderRegistry.getCapabilities('bedrock')
			expect(caps).toEqual(BEDROCK_CAPABILITIES)
		})
	})

	describe('BEDROCK_CAPABILITIES', () => {
		it('declares the expected capability flags', () => {
			expect(BEDROCK_CAPABILITIES).toEqual({
				supportsTools: true,
				supportsStreaming: true,
				supportsFunctionCalling: true,
			})
		})
	})
})
