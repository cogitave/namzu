import type {
	LLMProvider,
	LLMProviderConstructor,
	ProviderCapabilities,
	ProviderConfigRegistry,
	ProviderFactoryConfig,
	ProviderFactoryResult,
	ProviderType,
	RegisterOptions,
} from '../types/provider/index.js'

export class UnknownProviderError extends Error {
	readonly providerType: string

	constructor(providerType: string) {
		super(`Unsupported provider type: ${providerType}`)
		this.name = 'UnknownProviderError'
		this.providerType = providerType
	}
}

export class DuplicateProviderError extends Error {
	readonly providerType: string

	constructor(providerType: string) {
		super(
			`Provider type "${providerType}" is already registered. Pass { replace: true } to override an existing registration.`,
		)
		this.name = 'DuplicateProviderError'
		this.providerType = providerType
	}
}

// Module-private state. Only the exported functions below can read/mutate.
const providers = new Map<string, LLMProviderConstructor<unknown>>()
const capabilities = new Map<string, ProviderCapabilities>()

/**
 * Central registry for LLM providers.
 *
 * Provider packages (@namzu/bedrock, @namzu/openai, etc.) export a
 * `register<Vendor>()` function that calls `ProviderRegistry.register()`
 * with a vendor-specific type string, provider class, and capabilities.
 *
 * The core sdk pre-registers `MockLLMProvider` under type `'mock'`.
 *
 * @example
 * ```ts
 * import { ProviderRegistry } from '@namzu/sdk'
 * import { registerBedrock } from '@namzu/bedrock'
 *
 * registerBedrock()
 *
 * const { provider, capabilities } = ProviderRegistry.create({
 *   type: 'bedrock',
 *   region: 'us-east-1',
 * })
 * ```
 */
export class ProviderRegistry {
	static register<K extends ProviderType>(
		type: K,
		ctor: LLMProviderConstructor<ProviderConfigRegistry[K]>,
		caps: ProviderCapabilities,
		options?: RegisterOptions,
	): void {
		if (providers.has(type) && !options?.replace) {
			throw new DuplicateProviderError(type)
		}
		providers.set(type, ctor as LLMProviderConstructor<unknown>)
		capabilities.set(type, caps)
	}

	static create(config: ProviderFactoryConfig): ProviderFactoryResult {
		const provider = ProviderRegistry.createProvider(config)
		const caps = ProviderRegistry.getCapabilities(config.type)
		return { provider, capabilities: caps }
	}

	static createProvider(config: ProviderFactoryConfig): LLMProvider {
		const Ctor = providers.get(config.type)
		if (!Ctor) {
			throw new UnknownProviderError(config.type)
		}
		return new Ctor(config)
	}

	static getCapabilities(type: string): ProviderCapabilities {
		const caps = capabilities.get(type)
		if (!caps) {
			throw new UnknownProviderError(type)
		}
		return caps
	}

	static isSupported(type: string): type is ProviderType {
		return providers.has(type)
	}

	static unregister(type: ProviderType): boolean {
		capabilities.delete(type)
		return providers.delete(type)
	}

	static listTypes(): ProviderType[] {
		return Array.from(providers.keys()) as ProviderType[]
	}
}

/**
 * @internal — not exported from the package barrel. Do not use in production code.
 * Available to in-tree tests via relative import (`./provider/registry.js`).
 * External consumers cannot reach this because `@namzu/sdk` only exports `.`.
 */
export function __resetProviderRegistryInternal(): void {
	providers.clear()
	capabilities.clear()
}
