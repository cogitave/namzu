import { type ProviderCapabilities, ProviderRegistry, type RegisterOptions } from '@namzu/sdk'
import { OpenAIProvider } from './client.js'
import type { OpenAIProviderConfig } from './types.js'

// Module augmentation: register openai's config type in the sdk's registry interface.
// This must live inside index.ts (not a .d.ts) so it executes when index.ts is imported.
declare module '@namzu/sdk' {
	interface ProviderConfigRegistry {
		openai: OpenAIProviderConfig
	}
}

export const OPENAI_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
}

/**
 * Register `OpenAIProvider` under the `'openai'` type in `@namzu/sdk`'s
 * `ProviderRegistry`. Call once at app startup before
 * `ProviderRegistry.create({ type: 'openai', ... })`.
 *
 * Throws `DuplicateProviderError` if `'openai'` is already registered.
 * Pass `{ replace: true }` to override.
 */
export function registerOpenAI(options?: RegisterOptions): void {
	ProviderRegistry.register('openai', OpenAIProvider, OPENAI_CAPABILITIES, options)
}

export { OpenAIProvider } from './client.js'
export type { OpenAIConfig, OpenAIProviderConfig } from './types.js'
