import { ProviderRegistry, type RegisterOptions } from '@namzu/sdk'
import { GOOGLE_CAPABILITIES, GoogleProvider } from './client.js'
import type { GoogleProviderConfig } from './types.js'
declare module '@namzu/sdk' {
	interface ProviderConfigRegistry {
		google: GoogleProviderConfig
	}
}
export function registerGoogle(options?: RegisterOptions): void {
	ProviderRegistry.register('google', GoogleProvider, GOOGLE_CAPABILITIES, options)
}
export {
	GoogleProvider,
	GOOGLE_CAPABILITIES,
	DEFAULT_GEMINI_MODEL,
} from './client.js'
export type { GoogleConfig, GoogleProviderConfig } from './types.js'
