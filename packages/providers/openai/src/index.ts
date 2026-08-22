import { ProviderRegistry, type RegisterOptions } from '@namzu/sdk'
import { OPENAI_CAPABILITIES, OpenAIProvider } from './client.js'
import { CODEX_CAPABILITIES, CodexProvider } from './codex.js'
import type { OpenAIProviderConfig } from './types.js'
import type { CodexProviderConfig } from './types.js'

// Module augmentation: register openai's config type in the sdk's registry interface.
// This must live inside index.ts (not a .d.ts) so it executes when index.ts is imported.
declare module '@namzu/sdk' {
	interface ProviderConfigRegistry {
		openai: OpenAIProviderConfig
		codex: CodexProviderConfig
	}
}

/** Register the ChatGPT subscription-backed Codex Responses transport. */
export function registerCodex(options?: RegisterOptions): void {
	ProviderRegistry.register('codex', CodexProvider, CODEX_CAPABILITIES, options)
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

export {
	OPENAI_CAPABILITIES,
	OpenAIProvider,
	openAIReasoningEffortLevels,
} from './client.js'
export {
	CODEX_CAPABILITIES,
	CodexProvider,
} from './codex.js'
export type {
	CodexConfig,
	CodexProviderConfig,
	OpenAIConfig,
	OpenAIProviderConfig,
} from './types.js'
