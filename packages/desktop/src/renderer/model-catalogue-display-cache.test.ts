import { afterEach, expect, it, vi } from 'vitest'
import type { ModelCatalogueView } from '../shared/protocol.js'
import {
	ModelCatalogueDisplayCache,
	invalidateModelCatalogueDisplayCache,
	modelCatalogueDisplayCacheForApi,
} from './model-catalogue-display-cache.js'

const provider = { id: 'sample', label: 'Sample', defaultModel: 'default' }
const catalogue = (label: string): ModelCatalogueView => ({
	models: [{ id: 'default', label }],
	notice: null,
})
const scope = (
	cache: ModelCatalogueDisplayCache,
	input: { projectId?: string; sessionId?: string; harnessScope?: string; label?: string } = {},
) =>
	cache.scope({
		projectId: input.projectId ?? 'project',
		sessionId: input.sessionId ?? 'session',
		harnessScope: input.harnessScope ?? 'namzu',
		provider,
		available: [{ ...provider, label: input.label ?? provider.label }],
	})

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

afterEach(() => vi.useRealTimers())

it('coalesces a scoped in-flight read and reuses a short-lived display result', async () => {
	const cache = new ModelCatalogueDisplayCache()
	const key = scope(cache)
	const pending = deferred<ModelCatalogueView>()
	const read = vi.fn(() => pending.promise)
	const first = cache.load(key, read)
	const second = cache.load(key, read)
	expect(first).toBe(second)
	expect(cache.peek(key)).toEqual({ state: 'loading' })
	pending.resolve(catalogue('Known model'))
	expect(await first).toMatchObject({ current: true, retained: true })
	expect(read).toHaveBeenCalledTimes(1)
	expect(cache.peek(key)).toEqual({ state: 'ready', value: catalogue('Known model') })
	expect(await cache.load(key, read)).toMatchObject({ current: true, retained: true })
	expect(read).toHaveBeenCalledTimes(1)
})

it('keys by exact owner and engine metadata, while a model choice alone does not change the key', () => {
	const cache = new ModelCatalogueDisplayCache()
	const original = scope(cache)
	expect(scope(cache).key).toBe(original.key)
	for (const changed of [
		{ projectId: 'other' },
		{ sessionId: 'other' },
		{ harnessScope: 'codex-cli' },
		{ label: 'Other account catalogue label' },
	])
		expect(scope(cache, changed).key).not.toBe(original.key)
	const firstApi = { models: vi.fn() }
	const secondApi = { models: vi.fn() }
	expect(modelCatalogueDisplayCacheForApi(firstApi)).toBe(
		modelCatalogueDisplayCacheForApi(firstApi),
	)
	expect(modelCatalogueDisplayCacheForApi(firstApi)).not.toBe(
		modelCatalogueDisplayCacheForApi(secondApi),
	)
})

it('ignores only native provider choice echoes while retaining real catalogue metadata boundaries', async () => {
	const cache = new ModelCatalogueDisplayCache()
	const make = (
		id: string,
		defaultModel: string,
		options: { label?: string; sessionId?: string; harnessScope?: string; projectId?: string } = {},
	) =>
		cache.scope({
			projectId: options.projectId ?? 'project',
			sessionId: options.sessionId ?? 'session',
			harnessScope: options.harnessScope ?? id,
			provider: { id, label: options.label ?? id, defaultModel },
			available: [{ id, label: options.label ?? id, defaultModel }],
		})
	const codex = make('codex-cli', 'native-a')
	const read = vi.fn(async () => catalogue('Native catalogue'))
	await cache.load(codex, read)
	const switched = make('codex-cli', 'native-b')
	expect(switched.key).toBe(codex.key)
	expect(cache.peek(switched).state).toBe('ready')
	await cache.load(switched, read)
	expect(read).toHaveBeenCalledTimes(1)
	expect(make('claude-code', 'native-a').key).toBe(make('claude-code', 'native-b').key)
	expect(make('zen', 'model-a', { harnessScope: 'namzu' }).key).not.toBe(
		make('zen', 'model-b', { harnessScope: 'namzu' }).key,
	)
	for (const changed of [
		{ label: 'Other account metadata' },
		{ sessionId: 'other' },
		{ projectId: 'other' },
		{ harnessScope: 'other' },
	])
		expect(make('codex-cli', 'native-b', changed).key).not.toBe(codex.key)
	expect(make('claude-code', 'native-b').key).not.toBe(codex.key)
	cache.invalidate('project')
	expect(make('codex-cli', 'native-b').key).not.toBe(codex.key)
})

it('expires cached rows by a fake clock and permits explicit refresh before expiry', async () => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-10-06T00:00:00.000Z'))
	const cache = new ModelCatalogueDisplayCache()
	const key = scope(cache)
	const read = vi
		.fn()
		.mockResolvedValueOnce(catalogue('First'))
		.mockResolvedValueOnce(catalogue('Fresh'))
	await cache.load(key, read)
	expect(cache.peek(key)).toEqual({ state: 'ready', value: catalogue('First') })
	await cache.load(key, read, true)
	expect(cache.peek(key)).toEqual({ state: 'ready', value: catalogue('Fresh') })
	expect(read).toHaveBeenCalledTimes(2)
	vi.advanceTimersByTime(120_001)
	expect(cache.peek(key)).toEqual({ state: 'idle' })
})

it('ignores an older refresh result and keeps failed reads retryable', async () => {
	const cache = new ModelCatalogueDisplayCache()
	const key = scope(cache)
	const old = deferred<ModelCatalogueView>()
	const fresh = deferred<ModelCatalogueView>()
	const older = cache.load(key, () => old.promise)
	const newer = cache.load(key, () => fresh.promise, true)
	old.resolve(catalogue('Obsolete'))
	expect(await older).toEqual({ current: false })
	expect(cache.peek(key)).toEqual({ state: 'loading' })
	fresh.resolve(catalogue('Current'))
	expect(await newer).toMatchObject({ current: true, retained: true })
	expect(cache.peek(key)).toEqual({ state: 'ready', value: catalogue('Current') })
	await expect(
		cache.load(
			key,
			async () => {
				throw new Error('private detail')
			},
			true,
		),
	).rejects.toThrow()
	expect(cache.peek(key)).toEqual({ state: 'error' })
	await cache.load(key, async () => catalogue('After retry'), true)
	expect(cache.peek(key)).toEqual({ state: 'ready', value: catalogue('After retry') })
})

it('invalidates a re-bound project and does not publish its old pending result', async () => {
	const api = { models: vi.fn() }
	const cache = modelCatalogueDisplayCacheForApi(api)
	const oldScope = scope(cache)
	const otherScope = scope(cache, { projectId: 'other' })
	await cache.load(otherScope, async () => catalogue('Other project'))
	const pending = deferred<ModelCatalogueView>()
	const oldRead = cache.load(oldScope, () => pending.promise)
	invalidateModelCatalogueDisplayCache(api, 'project')
	const newScope = scope(cache)
	expect(newScope.key).not.toBe(oldScope.key)
	pending.resolve(catalogue('Old account'))
	expect(await oldRead).toEqual({ current: false })
	expect(cache.peek(newScope)).toEqual({ state: 'idle' })
	expect(cache.peek(otherScope)).toEqual({ state: 'ready', value: catalogue('Other project') })
	await cache.load(newScope, async () => catalogue('New account'))
	expect(cache.peek(newScope)).toEqual({ state: 'ready', value: catalogue('New account') })
	invalidateModelCatalogueDisplayCache(api)
	expect(scope(cache).key).not.toBe(newScope.key)
})

it('bounds retained rows and lets a too-large catalogue render without retaining it', async () => {
	const cache = new ModelCatalogueDisplayCache()
	for (let index = 0; index < 50; index++)
		await cache.load(scope(cache, { sessionId: `session-${index}` }), async () =>
			catalogue(`Row ${index}`),
		)
	expect(cache.peek(scope(cache, { sessionId: 'session-0' }))).toEqual({ state: 'idle' })
	expect(cache.peek(scope(cache, { sessionId: 'session-49' })).state).toBe('ready')
	const huge = catalogue('x'.repeat(300_000))
	const hugeKey = scope(cache, { sessionId: 'huge' })
	expect(await cache.load(hugeKey, async () => huge)).toMatchObject({
		current: true,
		retained: false,
		value: huge,
	})
	expect(cache.peek(hugeKey)).toEqual({ state: 'idle' })
})

it('keeps the last good list for display after it expires or a later read fails, until invalidated', async () => {
	vi.useFakeTimers()
	const cache = new ModelCatalogueDisplayCache()
	const key = scope(cache)
	expect(cache.lastKnown(key)).toBeUndefined()
	await cache.load(key, async () => catalogue('First'))
	vi.setSystemTime(Date.now() + 10 * 60_000)
	expect(cache.peek(key).state).toBe('idle')
	expect(cache.lastKnown(key)?.models[0]?.label).toBe('First')
	await expect(
		cache.load(
			key,
			async () => {
				throw new Error('offline')
			},
			true,
		),
	).rejects.toThrow('offline')
	expect(cache.peek(key).state).toBe('error')
	expect(cache.lastKnown(key)?.models[0]?.label).toBe('First')
	cache.invalidate()
	expect(cache.lastKnown(key)).toBeUndefined()
})

it('re-reads the scopes a main-process update names, keeping the last list in view', async () => {
	const cache = new ModelCatalogueDisplayCache()
	const key = scope(cache)
	const otherEngine = scope(cache, { harnessScope: 'codex-cli' })
	await cache.load(key, async () => catalogue('Old'))
	await cache.load(otherEngine, async () => catalogue('Other engine'))
	const seen = vi.fn()
	cache.subscribe(seen)
	cache.catalogueUpdated('namzu', 'sample')
	expect(cache.peek(key)).toEqual({ state: 'idle' })
	expect(cache.lastKnown(key)).toEqual(catalogue('Old'))
	expect(seen).toHaveBeenCalledTimes(1)
	expect(cache.peek(otherEngine)).toMatchObject({ state: 'ready' })
	cache.catalogueUpdated('namzu', 'unrelated')
	expect(seen).toHaveBeenCalledTimes(1)
	const read = vi.fn(async () => catalogue('New'))
	await cache.load(key, read)
	expect(read).toHaveBeenCalledTimes(1)
	expect(cache.peek(key)).toEqual({ state: 'ready', value: catalogue('New') })
})

it('leaves a read that is already running alone when an update arrives', async () => {
	const cache = new ModelCatalogueDisplayCache()
	const key = scope(cache)
	const pending = deferred<ModelCatalogueView>()
	const loading = cache.load(key, () => pending.promise)
	cache.catalogueUpdated('namzu', 'sample')
	expect(cache.peek(key)).toEqual({ state: 'loading' })
	pending.resolve(catalogue('Fresh'))
	expect(await loading).toMatchObject({ current: true, retained: true })
})

it('names a model from the same engine and provider read for another conversation', async () => {
	const cache = new ModelCatalogueDisplayCache()
	await cache.load(scope(cache, { sessionId: 'one', harnessScope: 'codex' }), async () =>
		catalogue('Read in one'),
	)
	const other = scope(cache, { sessionId: 'two', harnessScope: 'codex' })
	expect(cache.peek(other)).toEqual({ state: 'idle' })
	expect(cache.lastKnownForEngine('codex', 'sample')?.models[0]?.label).toBe('Read in one')
	expect(cache.lastKnownForEngine('namzu', 'sample')).toBeUndefined()
	cache.invalidate()
	expect(cache.lastKnownForEngine('codex', 'sample')).toBeUndefined()
})
