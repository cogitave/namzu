import { ProviderRegistry, type RegisterOptions } from '@namzu/sdk'
import { ZEN_CAPABILITIES, ZenGoProvider, ZenProvider } from './client.js'
import type { ZenGoProviderConfig, ZenProviderConfig } from './types.js'

declare module '@namzu/sdk' {
	interface ProviderConfigRegistry {
		zen: ZenProviderConfig
		'zen-go': ZenGoProviderConfig
	}
}

export function registerZen(options?: RegisterOptions): void {
	ProviderRegistry.register('zen', ZenProvider, ZEN_CAPABILITIES, options)
}

export function registerZenGo(options?: RegisterOptions): void {
	ProviderRegistry.register('zen-go', ZenGoProvider, ZEN_CAPABILITIES, options)
}

export {
	ZEN_BASE_URL,
	ZEN_GO_BASE_URL,
	ZEN_CAPABILITIES,
	ZenProvider,
	ZenGoProvider,
} from './client.js'
export type { ZenConfig, ZenGoConfig, ZenProviderConfig, ZenGoProviderConfig } from './types.js'
export { getZenModels, findZenModel } from './models.js'
export type { ZenModel, ZenProtocol, ZenService } from './models.js'
export type {
	ChatCompletionParams,
	ModelInfo,
	ReasoningEffort,
	StreamChunk,
	ThinkingConfig,
} from '@namzu/sdk'
