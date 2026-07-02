import type {
	LLMProvider,
	LLMProviderConstructor,
	LazyProviderLoader,
	LazyProviderModule,
	ProviderCapabilities,
	ProviderConfigRegistry,
	ProviderFactoryConfig,
	ProviderFactoryResult,
	ProviderType,
	RegisterLazyOptions,
	RegisterOptions,
} from '../types/provider/index.js'
import { PERMISSIVE_PROVIDER_CAPABILITIES } from './capabilities.js'

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
 * The loader passed to `ProviderRegistry.registerLazy()` rejected (or
 * resolved to something without a `create(config)` function). Wraps the
 * original failure as `cause`. The failed load is NOT cached — the next
 * `createAsync()` for the type re-invokes the loader, so a transient
 * failure (network hiccup during a dynamic import) does not permanently
 * poison the type.
 */
export class LazyProviderLoadError extends Error {
	readonly providerType: string

	constructor(providerType: string, cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause)
		super(`Failed to load lazy provider "${providerType}": ${detail}`, { cause })
		this.name = 'LazyProviderLoadError'
		this.providerType = providerType
	}
}

/**
 * A synchronous `create()`/`createProvider()` was called for a type
 * registered via `registerLazy()`. Lazy types are only constructible
 * through the async path — deterministically, even after the loader has
 * resolved, so calling code never depends on load-order timing.
 */
export class LazyProviderSyncCreateError extends Error {
	readonly providerType: string

	constructor(providerType: string) {
		super(
			`Provider type "${providerType}" is registered lazily; synchronous create()/createProvider() cannot load it. Use ProviderRegistry.createAsync() or createProviderAsync().`,
		)
		this.name = 'LazyProviderSyncCreateError'
		this.providerType = providerType
	}
}

interface LazyProviderEntry {
	loader: LazyProviderLoader<unknown>
	/** In-flight load shared by concurrent first-creates (dedupe). */
	loading?: Promise<LazyProviderModule<unknown>>
	/** Cached module — set only on SUCCESS, so failures retry. */
	module?: LazyProviderModule<unknown>
}

// Module-private state. Only the exported functions below can read/mutate.
const providers = new Map<string, LLMProviderConstructor<unknown>>()
const capabilities = new Map<string, ProviderCapabilities>()
const lazyProviders = new Map<string, LazyProviderEntry>()

async function loadLazyModule(
	type: string,
	entry: LazyProviderEntry,
): Promise<LazyProviderModule<unknown>> {
	if (entry.module) {
		return entry.module
	}
	let inflight = entry.loading
	if (!inflight) {
		// Promise.resolve().then(...) also catches loaders that throw synchronously.
		inflight = Promise.resolve()
			.then(() => entry.loader())
			.then((mod) => {
				if (typeof mod?.create !== 'function') {
					throw new TypeError(
						'loader resolved to a value without a create(config) function — map your dynamic import to { create: (config) => new Provider(config) }',
					)
				}
				return mod
			})
		entry.loading = inflight
	}
	try {
		const mod = await inflight
		entry.module = mod
		if (entry.loading === inflight) {
			entry.loading = undefined
		}
		// The loaded module's declaration is authoritative at the type level:
		// it replaces any registration-time hint for future getCapabilities().
		if (mod.capabilities) {
			capabilities.set(type, mod.capabilities)
		}
		return mod
	} catch (cause) {
		// Clear only OUR in-flight promise; a retry started by another caller
		// after an earlier failure must not be dropped.
		if (entry.loading === inflight) {
			entry.loading = undefined
		}
		throw new LazyProviderLoadError(type, cause)
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
 *
 * Hosts that must not eagerly bundle every provider client register a
 * LOADER instead and construct through the async path:
 *
 * @example
 * ```ts
 * ProviderRegistry.registerLazy(
 *   'anthropic',
 *   async () => {
 *     const m = await import('@namzu/anthropic')
 *     return { create: (c) => new m.AnthropicProvider(c), capabilities: m.ANTHROPIC_CAPABILITIES }
 *   },
 *   { capabilities: { supportsTools: true, supportsStreaming: true, supportsFunctionCalling: true } },
 * )
 *
 * const { provider } = await ProviderRegistry.createAsync({ type: 'anthropic', apiKey })
 * ```
 */
export class ProviderRegistry {
	static register<K extends ProviderType>(
		type: K,
		ctor: LLMProviderConstructor<ProviderConfigRegistry[K]>,
		caps: ProviderCapabilities,
		options?: RegisterOptions,
	): void {
		if ((providers.has(type) || lazyProviders.has(type)) && !options?.replace) {
			throw new DuplicateProviderError(type)
		}
		lazyProviders.delete(type)
		providers.set(type, ctor as LLMProviderConstructor<unknown>)
		capabilities.set(type, caps)
	}

	/**
	 * Register a provider type WITHOUT importing its implementation. The
	 * loader is not invoked here; the first `createAsync()` for the type
	 * awaits it, validates the resolved `{ create }` module, and caches it.
	 * Subsequent creates reuse the cached factory. Only SUCCESS is cached:
	 * a rejected load surfaces as `LazyProviderLoadError` and the next
	 * `createAsync()` retries the loader. Concurrent first-creates share a
	 * single in-flight load.
	 *
	 * Capability precedence (weakest first):
	 * 1. `options.capabilities` — pre-load HINT so `getCapabilities(type)`
	 *    answers without loading (absent hint ⇒ permissive default, matching
	 *    `resolveProviderCapabilities`'s treatment of undeclared providers).
	 * 2. the loaded module's `capabilities` — replaces the hint on load.
	 * 3. the constructed instance's own `LLMProvider.capabilities` — the
	 *    query runtime negotiates against the INSTANCE
	 *    (`resolveProviderCapabilities(provider)`), so if it differs from
	 *    both of the above, the instance wins where it matters.
	 *
	 * Lazy types are deliberately NOT constructible via the sync
	 * `create()`/`createProvider()` (throws `LazyProviderSyncCreateError`),
	 * even after the loader has resolved — sync behavior must not depend on
	 * whether some earlier call happened to load the module.
	 */
	static registerLazy<K extends ProviderType>(
		type: K,
		loader: LazyProviderLoader<ProviderConfigRegistry[K]>,
		options?: RegisterLazyOptions,
	): void {
		if ((providers.has(type) || lazyProviders.has(type)) && !options?.replace) {
			throw new DuplicateProviderError(type)
		}
		providers.delete(type)
		capabilities.delete(type)
		lazyProviders.set(type, { loader: loader as LazyProviderLoader<unknown> })
		if (options?.capabilities) {
			capabilities.set(type, options.capabilities)
		}
	}

	static create(config: ProviderFactoryConfig): ProviderFactoryResult {
		const provider = ProviderRegistry.createProvider(config)
		const caps = ProviderRegistry.getCapabilities(config.type)
		return { provider, capabilities: caps }
	}

	/**
	 * Async twin of `create()`. Works for BOTH eager and lazy registrations,
	 * so hosts can use one code path; for lazy types it performs the
	 * load-on-first-use described on `registerLazy()`.
	 */
	static async createAsync(config: ProviderFactoryConfig): Promise<ProviderFactoryResult> {
		const provider = await ProviderRegistry.createProviderAsync(config)
		// Read capabilities AFTER construction so a lazily-loaded module's
		// authoritative declaration (set during load) is what gets returned.
		const caps = ProviderRegistry.getCapabilities(config.type)
		return { provider, capabilities: caps }
	}

	static createProvider(config: ProviderFactoryConfig): LLMProvider {
		const Ctor = providers.get(config.type)
		if (!Ctor) {
			if (lazyProviders.has(config.type)) {
				throw new LazyProviderSyncCreateError(config.type)
			}
			throw new UnknownProviderError(config.type)
		}
		return new Ctor(config)
	}

	static async createProviderAsync(config: ProviderFactoryConfig): Promise<LLMProvider> {
		const Ctor = providers.get(config.type)
		if (Ctor) {
			return new Ctor(config)
		}
		const entry = lazyProviders.get(config.type)
		if (!entry) {
			throw new UnknownProviderError(config.type)
		}
		const mod = await loadLazyModule(config.type, entry)
		return mod.create(config)
	}

	/**
	 * Type-level capabilities. For a lazily-registered type this answers
	 * WITHOUT invoking the loader: the registration hint if one was given,
	 * otherwise the permissive default (assume everything — consistent with
	 * how `resolveProviderCapabilities` treats an undeclared provider). Once
	 * loaded, a module-shipped declaration replaces the hint. Note the query
	 * runtime negotiates against the constructed INSTANCE's own
	 * `capabilities`, which wins over anything stored here.
	 */
	static getCapabilities(type: string): ProviderCapabilities {
		const caps = capabilities.get(type)
		if (caps) {
			return caps
		}
		if (lazyProviders.has(type)) {
			return PERMISSIVE_PROVIDER_CAPABILITIES
		}
		throw new UnknownProviderError(type)
	}

	static isSupported(type: string): type is ProviderType {
		return providers.has(type) || lazyProviders.has(type)
	}

	static unregister(type: ProviderType): boolean {
		capabilities.delete(type)
		const hadLazy = lazyProviders.delete(type)
		return providers.delete(type) || hadLazy
	}

	static listTypes(): ProviderType[] {
		return Array.from(new Set([...providers.keys(), ...lazyProviders.keys()])) as ProviderType[]
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
	lazyProviders.clear()
}
