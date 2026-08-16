import type { ZodType, ZodTypeDef } from 'zod'

import { type ConfigOverrideStore, InMemoryConfigOverrideStore } from '../store/config/index.js'
import { type Logger, resolveLogger } from '../utils/logger.js'

/**
 * Configuration a plugin declares and an operator retunes while a run is
 * live.
 *
 * `config/runtime.ts` is one Zod schema parsed once into `RUNTIME_DEFAULTS`
 * and threaded around as a frozen object. Every section in it is one the SDK
 * author anticipated — taskRouter, compaction, agentBus, plugins, sandbox —
 * and nothing in `config/` watches, subscribes or changes. So a plugin has
 * no way to expose an operator-editable section of its own, and retuning one
 * knob means rebuilding the config object and restarting whatever consumed
 * it.
 *
 * **Live is the whole point.** A registry that resolved a value once and
 * handed it out would be the frozen object again with more ceremony. The
 * driver in this same change is the MCP reconnect supervisor, which reads
 * `get()` on every attempt — so raising `maxAttempts` during an outage takes
 * effect on the next retry rather than on the next process.
 *
 * Programmatic surface only: no JSON-schema export for a UI, and no
 * redaction. A secret in a config value is the vault's problem, and a
 * redactor here would be a second, weaker one.
 */

export interface ConfigScope<T> {
	/**
	 * The resolved value, now.
	 *
	 * Synchronous and cheap: consumers read it inside loops and timers, and
	 * an async read would make every one of them async for a value already in
	 * memory.
	 */
	get(): T
	/**
	 * Merge a patch over the override layer and re-validate.
	 *
	 * Throws on a schema-invalid result, leaving the previous value in place
	 * and firing no watcher — validate then assign, never the reverse.
	 * `refuse-do-not-degrade`: a config that accepted a bad value and clamped
	 * it would leave an operator believing they had set something they had
	 * not.
	 */
	update(patch: Partial<T> | Record<string, unknown>): T
	/** Called after a successful update. Returns an unsubscribe. */
	watch(listener: (next: T, previous: T) => void): () => void
}

export class ConfigNamespaceCollisionError extends Error {
	constructor(readonly namespace: string) {
		super(
			`Configuration namespace "${namespace}" is already registered. Two owners of one namespace means whichever registered second silently decides the schema, so this refuses instead.`,
		)
		this.name = 'ConfigNamespaceCollisionError'
	}
}

export interface ConfigRegistryOptions {
	/**
	 * Where overrides persist. Defaults to memory, which is honest for a
	 * process that has not been told where to keep them.
	 */
	readonly store?: ConfigOverrideStore
	readonly log?: Logger
	/**
	 * Prefix for this registry's store keys. Set by {@link ConfigRegistry.scope}.
	 *
	 * Two concurrent runs share a process and a store; without a prefix the
	 * second would read the first's overrides and retune it.
	 */
	readonly scopeId?: string
}

/**
 * Output first, input pinned to `unknown` — the shape every other schema
 * field in this tree uses (`ConnectorDefinition.configSchema`,
 * `ToolDefinition.inputSchema`).
 *
 * Not decoration. `ZodType<T>` alone leaves the input parameter free, so `T`
 * infers from the schema's INPUT as well as its output, and every `.default()`
 * field comes back optional: `get().attempts` types as `number | undefined`
 * for a field that always has a value. What is parsed here really is
 * `unknown` — a persisted override is whatever was on disk.
 */
type ConfigSchema<T> = ZodType<T, ZodTypeDef, unknown>

interface Entry<T> {
	readonly schema: ConfigSchema<T>
	readonly base: Record<string, unknown>
	override: Record<string, unknown>
	resolved: T
	readonly watchers: Set<(next: T, previous: T) => void>
}

export class ConfigRegistry {
	private readonly entries = new Map<string, Entry<unknown>>()
	private readonly store: ConfigOverrideStore
	private readonly persisted: Record<string, unknown>
	private readonly log: Logger
	private readonly scopeId: string | undefined

	constructor(options: ConfigRegistryOptions = {}) {
		this.store = options.store ?? new InMemoryConfigOverrideStore()
		this.persisted = this.store.load()
		this.log = resolveLogger(options.log).child({ 'namzu.log.scope': 'config/registry' })
		this.scopeId = options.scopeId
	}

	/**
	 * A registry for one run, sharing this one's store.
	 *
	 * Namespaces and watchers are per scope — two concurrent runs cannot see
	 * or retune each other — while the store is shared so an operator's
	 * override written under one scope is not lost when it ends. The same
	 * arrangement `ScopedConnectorRegistry` uses, keyed the same way.
	 */
	scope(scopeId: string): ConfigRegistry {
		return new ConfigRegistry({
			store: this.store,
			log: this.log,
			scopeId: this.scopeId ? `${this.scopeId}:${scopeId}` : scopeId,
		})
	}

	register<T>(
		namespace: string,
		schema: ConfigSchema<T>,
		options: { readonly base?: Record<string, unknown> } = {},
	): ConfigScope<T> {
		if (this.entries.has(namespace)) throw new ConfigNamespaceCollisionError(namespace)

		const base = options.base ?? {}
		const override = asRecord(this.persisted[this.storeKey(namespace)])
		// Schema defaults, then the plugin's declared base, then the operator's
		// override — and the whole thing through the schema, so a persisted
		// override written against an older shape is refused at registration
		// rather than at the first read.
		const entry: Entry<T> = {
			schema,
			base,
			override,
			resolved: schema.parse({ ...base, ...override }),
			watchers: new Set(),
		}
		this.entries.set(namespace, entry as Entry<unknown>)

		return {
			get: () => entry.resolved,
			update: (patch) => this.applyUpdate(namespace, entry, patch),
			watch: (listener) => {
				entry.watchers.add(listener)
				return () => entry.watchers.delete(listener)
			},
		}
	}

	/** Namespaces registered on THIS scope. */
	namespaces(): readonly string[] {
		return [...this.entries.keys()].sort()
	}

	private applyUpdate<T>(
		namespace: string,
		entry: Entry<T>,
		patch: Record<string, unknown> | Partial<T>,
	): T {
		const candidateOverride = { ...entry.override, ...(patch as Record<string, unknown>) }
		// Parsed BEFORE anything is assigned. An implementation that assigned
		// and then validated would leave the bad value readable through
		// `get()` for the duration of the throw, and would have already told
		// every watcher about it.
		const next = entry.schema.parse({ ...entry.base, ...candidateOverride })

		const previous = entry.resolved
		entry.override = candidateOverride
		entry.resolved = next
		this.store.save(this.storeKey(namespace), candidateOverride)

		for (const watcher of entry.watchers) {
			try {
				watcher(next, previous)
			} catch (err) {
				// Caught, not propagated — the same trade `MCPClient.emitLifecycle`
				// already makes. A watcher is host-supplied code, and letting one
				// throw out of `update` would roll a successful configuration
				// change back into an exception for every other watcher too.
				this.log.warn('a config watcher threw', {
					'namzu.config.namespace': namespace,
					'exception.message': err instanceof Error ? err.message : String(err),
				})
			}
		}
		return next
	}

	private storeKey(namespace: string): string {
		return this.scopeId ? `${this.scopeId}:${namespace}` : namespace
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? { ...(value as Record<string, unknown>) }
		: {}
}
