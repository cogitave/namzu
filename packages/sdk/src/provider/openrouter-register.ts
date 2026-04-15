import type { ProviderCapabilities } from '../types/provider/index.js'
import { OpenRouterProvider } from './openrouter/client.js'
import { ProviderRegistry } from './registry.js'

/**
 * Transitional: OpenRouterProvider lives in @namzu/sdk until extracted to @namzu/openrouter.
 * After extraction, this file and the `./openrouter/` directory are removed from sdk;
 * @namzu/openrouter will expose its own `registerOpenRouter()`.
 */

export const OPENROUTER_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
}

export function registerOpenRouter(): void {
	if (!ProviderRegistry.isSupported('openrouter')) {
		ProviderRegistry.register('openrouter', OpenRouterProvider, OPENROUTER_CAPABILITIES)
	}
}

registerOpenRouter()
