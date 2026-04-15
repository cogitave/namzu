import { type ProviderCapabilities, ProviderRegistry, type RegisterOptions } from '@namzu/sdk'
import { OpenRouterProvider } from './client.js'
import type { OpenRouterProviderConfig } from './types.js'

// Module augmentation: register openrouter's config type in the sdk's registry
// interface. This must live inside index.ts (not a .d.ts) so it executes when
// index.ts is imported.
declare module '@namzu/sdk' {
	interface ProviderConfigRegistry {
		openrouter: OpenRouterProviderConfig
	}
}

export const OPENROUTER_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
}

/**
 * Register `OpenRouterProvider` under the `'openrouter'` type in `@namzu/sdk`'s
 * `ProviderRegistry`. Call once at app startup before
 * `ProviderRegistry.create({ type: 'openrouter', ... })`.
 *
 * Throws `DuplicateProviderError` if `'openrouter'` is already registered.
 * Pass `{ replace: true }` to override.
 */
export function registerOpenRouter(options?: RegisterOptions): void {
	ProviderRegistry.register('openrouter', OpenRouterProvider, OPENROUTER_CAPABILITIES, options)
}

export { OpenRouterProvider } from './client.js'
export type { OpenRouterConfig, OpenRouterProviderConfig } from './types.js'
