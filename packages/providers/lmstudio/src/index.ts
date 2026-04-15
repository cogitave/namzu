import { type ProviderCapabilities, ProviderRegistry, type RegisterOptions } from '@namzu/sdk'
import { LMStudioProvider } from './client.js'
import type { LMStudioProviderConfig } from './types.js'

// Module augmentation: register lmstudio's config type in the sdk's registry interface.
// This must live inside index.ts (not a .d.ts) so it executes when index.ts is imported.
declare module '@namzu/sdk' {
	interface ProviderConfigRegistry {
		lmstudio: LMStudioProviderConfig
	}
}

export const LMSTUDIO_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
}

/**
 * Register `LMStudioProvider` under the `'lmstudio'` type in `@namzu/sdk`'s
 * `ProviderRegistry`. Call once at app startup before
 * `ProviderRegistry.create({ type: 'lmstudio', ... })`.
 *
 * Throws `DuplicateProviderError` if `'lmstudio'` is already registered.
 * Pass `{ replace: true }` to override.
 */
export function registerLMStudio(options?: RegisterOptions): void {
	ProviderRegistry.register('lmstudio', LMStudioProvider, LMSTUDIO_CAPABILITIES, options)
}

export { LMStudioProvider } from './client.js'
export type { LMStudioConfig, LMStudioProviderConfig } from './types.js'
