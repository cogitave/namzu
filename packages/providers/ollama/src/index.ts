import { type ProviderCapabilities, ProviderRegistry, type RegisterOptions } from '@namzu/sdk'
import { OllamaProvider } from './client.js'
import type { OllamaProviderConfig } from './types.js'

// Module augmentation: register ollama's config type in the sdk's registry
// interface. This must live inside index.ts (not a .d.ts) so it executes when
// index.ts is imported.
declare module '@namzu/sdk' {
	interface ProviderConfigRegistry {
		ollama: OllamaProviderConfig
	}
}

export const OLLAMA_CAPABILITIES: ProviderCapabilities = {
	supportsTools: false,
	supportsStreaming: true,
	supportsFunctionCalling: false,
}

/**
 * Register `OllamaProvider` under the `'ollama'` type in `@namzu/sdk`'s
 * `ProviderRegistry`. Call once at app startup before
 * `ProviderRegistry.create({ type: 'ollama', ... })`.
 *
 * Throws `DuplicateProviderError` if `'ollama'` is already registered.
 * Pass `{ replace: true }` to override.
 */
export function registerOllama(options?: RegisterOptions): void {
	ProviderRegistry.register('ollama', OllamaProvider, OLLAMA_CAPABILITIES, options)
}

export { OllamaProvider } from './client.js'
export type { OllamaConfig, OllamaProviderConfig } from './types.js'
