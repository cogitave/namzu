import type { ProviderCapabilities } from '../types/provider/index.js'
import { MockLLMProvider } from './mock.js'
import { ProviderRegistry } from './registry.js'

export const MOCK_CAPABILITIES: ProviderCapabilities = {
	supportsTools: false,
	supportsStreaming: true,
	supportsFunctionCalling: false,
}

/**
 * Register the built-in MockLLMProvider under type `'mock'`.
 *
 * This is invoked automatically on `@namzu/sdk` import (side-effect whitelisted
 * via `package.json#sideEffects`). Users never need to call this explicitly.
 *
 * Exposed for tests that reset the registry via `ProviderRegistry._reset()`.
 */
export function registerMock(): void {
	if (!ProviderRegistry.isSupported('mock')) {
		ProviderRegistry.register('mock', MockLLMProvider, MOCK_CAPABILITIES)
	}
}

// Auto-register on module load. This module is listed in sdk's
// `package.json#sideEffects` so bundlers preserve this line under tree-shaking.
registerMock()
