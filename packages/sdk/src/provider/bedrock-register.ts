import type { ProviderCapabilities } from '../types/provider/index.js'
import { BedrockProvider } from './bedrock/client.js'
import { ProviderRegistry } from './registry.js'

/**
 * Transitional: BedrockProvider lives in @namzu/sdk until extracted to @namzu/bedrock.
 * After extraction, this file and the `./bedrock/` directory are removed from sdk;
 * @namzu/bedrock will expose its own `registerBedrock()`.
 */

export const BEDROCK_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
}

export function registerBedrock(): void {
	if (!ProviderRegistry.isSupported('bedrock')) {
		ProviderRegistry.register('bedrock', BedrockProvider, BEDROCK_CAPABILITIES)
	}
}

registerBedrock()
