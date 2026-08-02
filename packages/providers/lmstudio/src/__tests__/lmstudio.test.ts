import { DuplicateProviderError, ProviderRegistry } from '@namzu/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
// NOTE: no provider-instance capability test here — LMStudioClient dials the
// local server eagerly on construction, which produces unhandled rejections in
// CI. The class field `capabilities = LMSTUDIO_CAPABILITIES` is a one-liner
// covered by the constant assertion below.
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
			// Honest driver flags: tool schemas are sent and calls are
			// surfaced, but an image would have to be uploaded and referenced
			// by handle first, and this driver does not make that round-trip —
			// so `attachments` are still dropped and vision says false.
			expect(LMSTUDIO_CAPABILITIES).toEqual({
				supportsTools: true,
				supportsStreaming: true,
				supportsFunctionCalling: true,
				supportsVision: false,
			})
		})
	})
})
