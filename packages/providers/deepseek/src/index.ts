import { ProviderRegistry, type RegisterOptions } from '@namzu/sdk'
import { DEEPSEEK_CAPABILITIES, DeepSeekProvider } from './client.js'
import type { DeepSeekProviderConfig } from './types.js'

// Module augmentation: register deepseek's config type in the sdk's registry
// interface. This must live inside index.ts (not a .d.ts) so it executes when
// index.ts is imported.
declare module '@namzu/sdk' {
	interface ProviderConfigRegistry {
		deepseek: DeepSeekProviderConfig
	}
}

/**
 * Register `DeepSeekProvider` under the `'deepseek'` type in `@namzu/sdk`'s
 * `ProviderRegistry`. Call once at app startup before
 * `ProviderRegistry.create({ type: 'deepseek', ... })`.
 *
 * Throws `DuplicateProviderError` if `'deepseek'` is already registered.
 * Pass `{ replace: true }` to override.
 */
export function registerDeepSeek(options?: RegisterOptions): void {
	ProviderRegistry.register('deepseek', DeepSeekProvider, DEEPSEEK_CAPABILITIES, options)
}

export {
	DEEPSEEK_CAPABILITIES,
	DeepSeekProvider,
	assertEffortUnsupported,
	assertSamplingUsable,
	thinkingEnabled,
	toDeepSeekMessages,
	toDeepSeekTools,
} from './client.js'
export type { DeepSeekConfig, DeepSeekProviderConfig } from './types.js'
