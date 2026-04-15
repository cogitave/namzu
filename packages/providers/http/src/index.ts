import { type ProviderCapabilities, ProviderRegistry, type RegisterOptions } from '@namzu/sdk'
import { HttpProvider } from './client.js'
import type { HttpProviderConfig } from './types.js'

// Module augmentation: register http's config type in the sdk's registry interface.
// This must live inside index.ts (not a .d.ts) so it executes when index.ts is imported.
declare module '@namzu/sdk' {
	interface ProviderConfigRegistry {
		http: HttpProviderConfig
	}
}

export const HTTP_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
}

/**
 * Register `HttpProvider` under the `'http'` type in `@namzu/sdk`'s
 * `ProviderRegistry`. Call once at app startup before
 * `ProviderRegistry.create({ type: 'http', ... })`.
 *
 * Throws `DuplicateProviderError` if `'http'` is already registered.
 * Pass `{ replace: true }` to override.
 */
export function registerHttp(options?: RegisterOptions): void {
	ProviderRegistry.register('http', HttpProvider, HTTP_CAPABILITIES, options)
}

export { HttpProvider } from './client.js'
export { DialectMismatchError } from './types.js'
export type { HttpConfig, HttpDialect, HttpProviderConfig } from './types.js'
