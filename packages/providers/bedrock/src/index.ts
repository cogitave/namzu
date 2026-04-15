import { type ProviderCapabilities, ProviderRegistry, type RegisterOptions } from '@namzu/sdk'
import { BedrockProvider } from './client.js'
import type { BedrockProviderConfig } from './types.js'

// Module augmentation: register bedrock's config type in the sdk's registry interface.
// This must live inside index.ts (not a .d.ts) so it executes when index.ts is imported.
declare module '@namzu/sdk' {
	interface ProviderConfigRegistry {
		bedrock: BedrockProviderConfig
	}
}

export const BEDROCK_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
}

/**
 * Register `BedrockProvider` under the `'bedrock'` type in `@namzu/sdk`'s
 * `ProviderRegistry`. Call once at app startup before
 * `ProviderRegistry.create({ type: 'bedrock', ... })`.
 *
 * Throws `DuplicateProviderError` if `'bedrock'` is already registered.
 * Pass `{ replace: true }` to override.
 */
export function registerBedrock(options?: RegisterOptions): void {
	ProviderRegistry.register('bedrock', BedrockProvider, BEDROCK_CAPABILITIES, options)
}

export { BedrockProvider } from './client.js'
export type { BedrockConfig, BedrockProviderConfig } from './types.js'
