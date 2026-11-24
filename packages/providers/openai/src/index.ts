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
export {
	OPENAI_FAST_TABLE,
	PLAN_MULTIPLIER,
	isFirstPartyOpenAIEndpoint,
	resolveFastMode as resolveFastModeVerdict,
	servedSpeed,
	supportsFastMode,
} from './fast-mode.js'
export {
	CODEX_DEFAULT_BASE_URL,
	CODEX_IMAGE_LIMIT_IDS,
	CODEX_IMAGE_MAX_BYTES,
	CODEX_IMAGE_MODEL,
	CODEX_IMAGE_TIMEOUT_MS,
	CodexImagesError,
	requestCodexImage,
	sniffImageType,
} from './images.js'
export type {
	CodexImageRequest,
	CodexImageResult,
	CodexImageUsageLimit,
	CodexImagesConfig,
} from './images.js'
export type {
	FastTier,
	OpenAIFastInput,
	OpenAIFastRate,
	OpenAIFastRoute,
	OpenAIFastVerdict,
} from './fast-mode.js'
export type {
	CodexConfig,
	CodexProviderConfig,
	OpenAIConfig,
	OpenAIProviderConfig,
} from './types.js'
