import type { LLMProvider } from './interface.js'

/**
 * Registry of provider config shapes keyed by provider type string.
 *
 * Third-party provider packages extend this interface via TypeScript module
 * augmentation. Each key in the registry becomes a valid `ProviderType`, and
 * consumers of `ProviderRegistry.create({ type: 'X', ... })` get discriminated
 * union narrowing to the correct config shape.
 *
 * @example
 * ```ts
 * // @namzu/bedrock package
 * declare module '@namzu/sdk' {
 *   interface ProviderConfigRegistry {
 *     bedrock: BedrockProviderConfig
 *   }
 * }
 * ```
 */
export interface ProviderConfigRegistry {
	mock: MockProviderConfig
}

export type ProviderType = keyof ProviderConfigRegistry & string

export type ProviderFactoryConfig = {
	[K in ProviderType]: ProviderConfigRegistry[K]
}[ProviderType]

export interface MockProviderConfig {
	type: 'mock'
	model?: string
	responseText?: string
	responseDelayMs?: number
}

/**
 * What a provider DRIVER actually does with the request — not what the
 * vendor API could theoretically support. A driver that never reads
 * `params.tools` declares `supportsTools: false` even if the backing
 * service has a tools endpoint; a driver that drops `attachments`
 * declares `supportsVision: false` even for a multimodal model.
 *
 * The query runtime consults these before each run (see
 * `resolveProviderCapabilities` in `provider/capabilities.ts`) so
 * degradation is loud instead of silent.
 */
export interface ProviderCapabilities {
	supportsTools: boolean
	supportsStreaming: boolean
	supportsFunctionCalling: boolean
	/**
	 * Whether the driver maps user-message image `attachments` into the
	 * provider request. Optional for compatibility with pre-existing
	 * declarations: absent ⇒ treated as vision-capable (permissive
	 * default — the runtime only warns when a driver explicitly says no).
	 */
	supportsVision?: boolean
	maxOutputTokens?: number
}

export interface ProviderFactoryResult {
	provider: LLMProvider
	capabilities: ProviderCapabilities
}

export interface RegisterOptions {
	/** When true, replace an existing registration. Default false → throw on duplicate. */
	replace?: boolean
}

/**
 * What a lazy loader must resolve to: a factory that constructs the
 * provider, plus (optionally) the provider package's authoritative
 * capability declaration resolved at load time.
 *
 * Designed so a host can map a dynamic import in one line:
 *
 * ```ts
 * ProviderRegistry.registerLazy('anthropic', async () => {
 *   const m = await import('@namzu/anthropic')
 *   return { create: (c) => new m.AnthropicProvider(c), capabilities: m.ANTHROPIC_CAPABILITIES }
 * })
 * ```
 */
export interface LazyProviderModule<C = unknown> {
	create: (config: C) => LLMProvider
	/**
	 * Authoritative type-level capabilities shipped by the loaded module.
	 * When present, replaces any registration-time hint in the registry.
	 */
	capabilities?: ProviderCapabilities
}

export type LazyProviderLoader<C = unknown> = () => Promise<LazyProviderModule<C>>

export interface RegisterLazyOptions extends RegisterOptions {
	/**
	 * Pre-load capability HINT so `ProviderRegistry.getCapabilities(type)`
	 * can answer without triggering the loader. Precedence (weakest first):
	 * this hint → the loaded module's `capabilities` → the constructed
	 * instance's own `LLMProvider.capabilities` (what the query runtime
	 * resolves via `resolveProviderCapabilities` and actually respects).
	 */
	capabilities?: ProviderCapabilities
}

export type LLMProviderConstructor<C = unknown> = new (config: C) => LLMProvider
