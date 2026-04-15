import { type ProviderCapabilities, ProviderRegistry, type RegisterOptions } from '@namzu/sdk'
import { AnthropicProvider } from './client.js'
import type { AnthropicProviderConfig } from './types.js'

// Module augmentation: register anthropic's config type in the sdk's registry interface.
// This must live inside index.ts (not a .d.ts) so it executes when index.ts is imported.
declare module '@namzu/sdk' {
	interface ProviderConfigRegistry {
		anthropic: AnthropicProviderConfig
	}
}

export const ANTHROPIC_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
}

/**
 * Register `AnthropicProvider` under the `'anthropic'` type in `@namzu/sdk`'s
 * `ProviderRegistry`. Call once at app startup before
 * `ProviderRegistry.create({ type: 'anthropic', ... })`.
 *
 * Throws `DuplicateProviderError` if `'anthropic'` is already registered.
 * Pass `{ replace: true }` to override.
 */
export function registerAnthropic(options?: RegisterOptions): void {
	ProviderRegistry.register('anthropic', AnthropicProvider, ANTHROPIC_CAPABILITIES, options)
}

export { AnthropicProvider } from './client.js'
export type { AnthropicConfig, AnthropicProviderConfig } from './types.js'
