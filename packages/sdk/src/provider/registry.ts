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
	private static providers = new Map<string, LLMProviderConstructor<unknown>>()
	private static capabilities = new Map<string, ProviderCapabilities>()

	static register<K extends ProviderType>(
		type: K,
		ctor: LLMProviderConstructor<ProviderConfigRegistry[K]>,
		caps: ProviderCapabilities,
		options?: RegisterOptions,
	): void {
		if (ProviderRegistry.providers.has(type) && !options?.replace) {
			throw new DuplicateProviderError(type)
		}
		ProviderRegistry.providers.set(type, ctor as LLMProviderConstructor<unknown>)
		ProviderRegistry.capabilities.set(type, caps)
	}

	static create(config: ProviderFactoryConfig): ProviderFactoryResult {
		const provider = ProviderRegistry.createProvider(config)
		const capabilities = ProviderRegistry.getCapabilities(config.type)
		return { provider, capabilities }
	}

	static createProvider(config: ProviderFactoryConfig): LLMProvider {
		const Ctor = ProviderRegistry.providers.get(config.type)
		if (!Ctor) {
			throw new UnknownProviderError(config.type)
		}
		return new Ctor(config)
	}

	static getCapabilities(type: string): ProviderCapabilities {
		const caps = ProviderRegistry.capabilities.get(type)
		if (!caps) {
			throw new UnknownProviderError(type)
		}
		return caps
	}

	static isSupported(type: string): type is ProviderType {
		return ProviderRegistry.providers.has(type)
	}

	static unregister(type: ProviderType): boolean {
		ProviderRegistry.capabilities.delete(type)
		return ProviderRegistry.providers.delete(type)
	}

	static listTypes(): ProviderType[] {
		return Array.from(ProviderRegistry.providers.keys()) as ProviderType[]
	}

	/**
	 * Testing-only: wipe all registrations.
	 * Caller is responsible for re-registering after reset (e.g. via `registerMock()`).
	 */
	static _reset(): void {
		ProviderRegistry.providers.clear()
		ProviderRegistry.capabilities.clear()
	}
}
