import type { DesktopApi, ModelCatalogueView, ProviderView } from '../shared/protocol.js'

// This is a short-lived display hint. Main still admits every model selection
// and settings read against the current conversation and connection.
const FRESH_MS = 120_000
const MAX_ENTRIES = 48
const MAX_ENTRY_CHARS = 262_144
const MAX_TOTAL_CHARS = 2_097_152
const MAX_PROJECT_EPOCHS = 256

type Provider = ProviderView['available'][number]

// The CLI's native providerStatus reports the selected route as defaultModel.
// It is a choice echo, not a native catalogue revision. Keep the actual
// provider ID, label, owner and harness in scope; main revalidates every send.
const catalogueMetadata = ({
	id,
	label,
	defaultModel,
}: Provider): [string, string, string | null] => [
	id,
	label,
	id === 'codex-cli' || id === 'claude-code' ? null : defaultModel,
]

export interface ModelCatalogueDisplayScope {
	projectId: string
	key: string
}

export type ModelCatalogueDisplaySnapshot =
	| { state: 'idle' }
	| { state: 'loading' }
	| { state: 'error' }
	| { state: 'ready'; value: ModelCatalogueView }

type Entry = {
	projectId: string
	state: 'loading' | 'error' | 'ready'
	value?: ModelCatalogueView
	chars: number
	expiresAt: number
	promise?: Promise<ModelCatalogueDisplayResult>
}

export type ModelCatalogueDisplayResult =
	| { current: false }
	| { current: true; retained: boolean; value: ModelCatalogueView }

let nextCacheId = 0

/** Per-API, per-window cache. No catalogue entry grants model or tool authority. */
export class ModelCatalogueDisplayCache {
	readonly id = ++nextCacheId
	private readonly entries = new Map<string, Entry>()
	private readonly projectEpochs = new Map<string, number>()
	private readonly listeners = new Set<() => void>()
	private globalEpoch = 0
	private revision = 0
	private retainedChars = 0

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	readonly version = (): number => this.revision

	scope(input: {
		projectId: string
		sessionId?: string
		provider: Provider
		available: ProviderView['available']
		harnessScope?: string
	}): ModelCatalogueDisplayScope {
		return {
			projectId: input.projectId,
			key: JSON.stringify([
				this.id,
				this.globalEpoch,
				this.projectEpochs.get(input.projectId) ?? 0,
				input.projectId,
				input.sessionId ?? null,
				input.harnessScope ?? null,
				input.provider.id,
				input.available.map(catalogueMetadata),
			]),
		}
	}

	peek(scope: ModelCatalogueDisplayScope): ModelCatalogueDisplaySnapshot {
		const entry = this.entries.get(scope.key)
		if (!entry || (entry.state === 'ready' && Date.now() >= entry.expiresAt))
			return { state: 'idle' }
		if (entry.state === 'ready')
			return entry.value ? { state: 'ready', value: entry.value } : { state: 'idle' }
		return { state: entry.state }
	}

	load(
		scope: ModelCatalogueDisplayScope,
		read: () => Promise<ModelCatalogueView>,
		refresh = false,
	): Promise<ModelCatalogueDisplayResult> {
		const existing = this.entries.get(scope.key)
		if (!refresh && existing) {
			if (existing.state === 'loading' && existing.promise) return existing.promise
			if (existing.state === 'ready' && existing.value && Date.now() < existing.expiresAt)
				return Promise.resolve({ current: true, retained: true, value: existing.value })
			if (existing.state === 'error')
				return Promise.reject(new Error('Model catalogue read failed.'))
		}
		if (existing) this.delete(scope.key)
		const entry: Entry = {
			projectId: scope.projectId,
			state: 'loading',
			chars: 0,
			expiresAt: 0,
		}
		this.entries.set(scope.key, entry)
		const pending = Promise.resolve()
			.then(read)
			.then((value): ModelCatalogueDisplayResult => {
				if (this.entries.get(scope.key) !== entry) return { current: false }
				const copy = structuredClone(value)
				const chars = JSON.stringify(copy).length
				if (chars > MAX_ENTRY_CHARS) {
					this.delete(scope.key)
					this.changed()
					return { current: true, retained: false, value: copy }
				}
				entry.state = 'ready'
				entry.value = copy
				entry.chars = chars
				entry.expiresAt = Date.now() + FRESH_MS
				entry.promise = undefined
				this.retainedChars += chars
				this.evict()
				this.changed()
				return { current: true, retained: this.entries.get(scope.key) === entry, value: copy }
			})
			.catch((error: unknown) => {
				if (this.entries.get(scope.key) === entry) {
					entry.state = 'error'
					entry.promise = undefined
					this.changed()
				}
				throw error
			})
		entry.promise = pending
		this.changed()
		return pending
	}

	invalidate(projectId?: string): void {
		if (projectId === undefined) {
			this.globalEpoch++
			this.entries.clear()
			this.projectEpochs.clear()
			this.retainedChars = 0
			this.changed()
			return
		}
		if (!this.projectEpochs.has(projectId) && this.projectEpochs.size >= MAX_PROJECT_EPOCHS) {
			this.globalEpoch++
			this.projectEpochs.clear()
			this.entries.clear()
			this.retainedChars = 0
		}
		this.projectEpochs.set(projectId, (this.projectEpochs.get(projectId) ?? 0) + 1)
		for (const [key, entry] of this.entries) if (entry.projectId === projectId) this.delete(key)
		this.changed()
	}

	private delete(key: string): void {
		const entry = this.entries.get(key)
		if (!entry) return
		this.retainedChars -= entry.chars
		this.entries.delete(key)
	}

	private evict(): void {
		for (const [key, entry] of this.entries) {
			if (this.entries.size <= MAX_ENTRIES && this.retainedChars <= MAX_TOTAL_CHARS) break
			if (entry.state !== 'loading') this.delete(key)
		}
	}

	private changed(): void {
		this.revision++
		for (const listener of this.listeners) listener()
	}
}

const apiCaches = new WeakMap<object, ModelCatalogueDisplayCache>()

export function modelCatalogueDisplayCacheForApi(
	api: Pick<DesktopApi, 'models'>,
): ModelCatalogueDisplayCache {
	let cache = apiCaches.get(api)
	if (!cache) {
		cache = new ModelCatalogueDisplayCache()
		apiCaches.set(api, cache)
	}
	return cache
}

/** Call when the project client/account or its engine binding changes. */
export function invalidateModelCatalogueDisplayCache(
	api: Pick<DesktopApi, 'models'>,
	projectId?: string,
): void {
	modelCatalogueDisplayCacheForApi(api).invalidate(projectId)
}
