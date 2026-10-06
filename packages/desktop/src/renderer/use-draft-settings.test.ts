import { beforeEach, expect, it, vi } from 'vitest'
import type { DesktopApi, DraftSettings } from '../shared/protocol.js'
import { DraftSettingsStore } from './draft-settings-store.js'
import { useDraftSettings } from './use-draft-settings.js'

// Run the actual hook and settings store while controlling eligibility cleanup,
// owner cleanup and each IPC promise independently, without DOM or clock races.
const hooks = vi.hoisted(() => ({
	refs: [] as { current: unknown }[],
	refIndex: 0,
	states: [] as unknown[],
	stateIndex: 0,
	callbacks: [] as { value: unknown; dependencies: readonly unknown[] }[],
	callbackIndex: 0,
	memos: [] as { value: unknown; dependencies: readonly unknown[] }[],
	memoIndex: 0,
	setups: [] as (() => undefined | (() => void))[],
	layoutSetups: [] as (() => undefined | (() => void))[],
}))
vi.mock('react', async (original) => ({
	...(await original<typeof import('react')>()),
	useRef(initial: unknown) {
		const index = hooks.refIndex++
		hooks.refs[index] ??= { current: initial }
		return hooks.refs[index]
	},
	useState(initial: unknown) {
		const index = hooks.stateIndex++
		if (!(index in hooks.states)) hooks.states[index] = initial
		return [
			hooks.states[index],
			(value: unknown) => {
				hooks.states[index] = typeof value === 'function' ? value(hooks.states[index]) : value
			},
		]
	},
	useCallback(value: unknown, dependencies: readonly unknown[]) {
		const index = hooks.callbackIndex++
		const previous = hooks.callbacks[index]
		if (
			!previous ||
			dependencies.length !== previous.dependencies.length ||
			dependencies.some((dependency, position) => dependency !== previous.dependencies[position])
		)
			hooks.callbacks[index] = { value, dependencies }
		return hooks.callbacks[index]?.value
	},
	useMemo<T>(create: () => T, dependencies: readonly unknown[]): T {
		const index = hooks.memoIndex++
		const previous = hooks.memos[index]
		if (
			!previous ||
			dependencies.length !== previous.dependencies.length ||
			dependencies.some((dependency, position) => dependency !== previous.dependencies[position])
		)
			hooks.memos[index] = { value: create(), dependencies }
		return hooks.memos[index]?.value as T
	},
	useEffect(setup: () => undefined | (() => void)) {
		hooks.setups.push(setup)
	},
	useLayoutEffect(setup: () => undefined | (() => void)) {
		hooks.layoutSetups.push(setup)
	},
}))

beforeEach(() => {
	vi.restoreAllMocks()
	hooks.refs = []
	hooks.refIndex = 0
	hooks.states = []
	hooks.stateIndex = 0
	hooks.callbacks = []
	hooks.callbackIndex = 0
	hooks.memos = []
	hooks.memoIndex = 0
	hooks.setups = []
	hooks.layoutSetups = []
})
function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
const nativeChoice: DraftSettings = {
	choice: { provider: 'codex-cli', model: 'actual-native-model' },
	options: { effort: 'high', permissionMode: 'plan' },
}
const newerChoice: DraftSettings = {
	choice: { provider: 'zen', model: 'actual-provider-model' },
	options: { permissionMode: 'prompt' },
}
function fixture() {
	const draftSettings = vi.fn<DesktopApi['draftSettings']>()
	const saveDraftSettings = vi.fn<DesktopApi['saveDraftSettings']>().mockResolvedValue(undefined)
	const api = { draftSettings, saveDraftSettings } as unknown as DesktopApi
	const report = vi.fn()
	const render = (owner = 'session', enabled = true, bridge = api) => {
		hooks.refIndex = 0
		hooks.stateIndex = 0
		hooks.callbackIndex = 0
		hooks.memoIndex = 0
		hooks.setups = []
		hooks.layoutSetups = []
		return useDraftSettings(owner, enabled, report, bridge)
	}
	const startEligibilityEffect = () => hooks.setups[0]?.()
	const startLifetimeEffect = () => hooks.layoutSetups[1]?.()
	const speculativeRender = (owner = 'session', enabled = true, bridge = api) => {
		const memos = hooks.memos.slice()
		const callbacks = hooks.callbacks.slice()
		const result = render(owner, enabled, bridge)
		// React discards a render that never commits; refs and incumbent async
		// operations are intentionally left alone to expose render-time mutation.
		hooks.memos = memos
		hooks.callbacks = callbacks
		return result
	}
	return {
		draftSettings,
		saveDraftSettings,
		report,
		render,
		speculativeRender,
		startEligibilityEffect,
		startLifetimeEffect,
	}
}

it('keeps an explicit owner refresh admitted when harness or history readiness pauses automatic loading', async () => {
	const f = fixture()
	const started = deferred<void>()
	const read = deferred<DraftSettings>()
	f.draftSettings.mockImplementation(() => {
		started.resolve()
		return read.promise
	})
	const opening = f.render()
	const eligibilityCleanup = f.startEligibilityEffect()
	const leaveOwner = f.startLifetimeEffect()
	const refreshing = opening.refresh('session')
	await started.promise
	eligibilityCleanup?.()
	f.render('session', false)
	f.startEligibilityEffect()
	read.resolve(nativeChoice)
	await refreshing
	expect(f.render('session', false).value).toEqual(nativeChoice)
	expect(f.render('session', false).error).toBeUndefined()
	f.render()
	f.startEligibilityEffect()
	expect(f.render().loading).toBe(false)
	expect(f.report).not.toHaveBeenCalled()
	leaveOwner?.()
})

it('shares a setup refresh started while paused when the same owner becomes eligible again', async () => {
	const f = fixture()
	const started = deferred<void>()
	const read = deferred<DraftSettings>()
	f.draftSettings.mockImplementation(() => {
		started.resolve()
		return read.promise
	})
	const opening = f.render('session', false)
	f.startEligibilityEffect()
	const leaveOwner = f.startLifetimeEffect()
	const refreshing = opening.refresh('session')
	await started.promise
	f.render()
	f.startEligibilityEffect()
	read.resolve(nativeChoice)
	await refreshing
	expect(f.draftSettings).toHaveBeenCalledExactlyOnceWith('session')
	expect(f.render().value).toEqual(nativeChoice)
	expect(f.render().loading).toBe(false)
	leaveOwner?.()
})

it.each(['owner', 'api'] as const)(
	'keeps the committed settings read when a speculative %s render is abandoned',
	async (replacement) => {
		const f = fixture()
		const started = deferred<void>()
		const read = deferred<DraftSettings>()
		f.draftSettings.mockImplementation(() => {
			started.resolve()
			return read.promise
		})
		const opening = f.render()
		const leave = f.startLifetimeEffect()
		const refreshing = opening.refresh('session')
		await started.promise
		if (replacement === 'owner') f.speculativeRender('another-owner')
		else
			f.speculativeRender('session', true, {
				draftSettings: vi.fn().mockResolvedValue({}),
				saveDraftSettings: vi.fn().mockResolvedValue(undefined),
			} as unknown as DesktopApi)
		read.resolve(nativeChoice)
		await refreshing
		expect(f.render().value).toEqual(nativeChoice)
		expect(f.render().loading).toBe(false)
		expect(f.report).not.toHaveBeenCalled()
		leave?.()
	},
)

it('fences genuine owner navigation and late old reads before admitting the same ID again', async () => {
	const f = fixture()
	const previous = deferred<DraftSettings>()
	const current = deferred<DraftSettings>()
	const oldStarted = deferred<void>()
	const newStarted = deferred<void>()
	f.draftSettings
		.mockImplementationOnce(() => {
			oldStarted.resolve()
			return previous.promise
		})
		.mockImplementationOnce(() => {
			newStarted.resolve()
			return current.promise
		})
	const opening = f.render()
	const leave = f.startLifetimeEffect()
	const older = opening.refresh('session')
	const refused = expect(older).rejects.toThrow('message settings changed while loading')
	await oldStarted.promise
	leave?.()
	f.render('another-owner', false)
	f.startLifetimeEffect()
	const returning = f.render()
	f.startLifetimeEffect()
	const newer = returning.refresh('session')
	await newStarted.promise
	previous.resolve(nativeChoice)
	await refused
	expect(f.render().value).toEqual({})
	expect(f.render().loading).toBe(true)
	current.resolve(newerChoice)
	await newer
	expect(f.render().value).toEqual(newerChoice)
	expect(f.report).not.toHaveBeenCalled()
})

it('refuses an old API result after committed layout cleanup and does not reuse its known choices', async () => {
	const f = fixture()
	const previous = deferred<DraftSettings>()
	const oldStarted = deferred<void>()
	f.draftSettings.mockImplementation(() => {
		oldStarted.resolve()
		return previous.promise
	})
	const opening = f.render()
	const leaveOld = f.startLifetimeEffect()
	const older = opening.refresh('session')
	const refused = expect(older).rejects.toThrow('message settings changed while loading')
	await oldStarted.promise
	const nextRead = vi.fn<DesktopApi['draftSettings']>().mockResolvedValue(newerChoice)
	const nextApi = { draftSettings: nextRead, saveDraftSettings: vi.fn() } as unknown as DesktopApi
	const replacement = f.render('session', true, nextApi)
	expect(replacement.loading).toBe(true)
	expect(replacement.value).toEqual({})
	leaveOld?.()
	f.startLifetimeEffect()
	const reloading = replacement.refresh('session')
	previous.resolve(nativeChoice)
	await refused
	await reloading
	expect(f.render('session', true, nextApi).value).toEqual(newerChoice)
	expect(f.render('session', true, nextApi).error).toBeUndefined()
	expect(nextRead).toHaveBeenCalledExactlyOnceWith('session')
	expect(f.report).not.toHaveBeenCalled()
})

it('does not report an old owner read failure after the next pane commits', async () => {
	const f = fixture()
	const previous = deferred<DraftSettings>()
	const started = deferred<void>()
	f.draftSettings
		.mockImplementationOnce(() => {
			started.resolve()
			return previous.promise
		})
		.mockResolvedValueOnce(newerChoice)
	const reads = vi.spyOn(DraftSettingsStore.prototype, 'load')
	f.render()
	f.startEligibilityEffect()
	const leave = f.startLifetimeEffect()
	const oldRead = reads.mock.results[0]?.value as Promise<void>
	await started.promise
	f.render('another-owner')
	leave?.()
	f.startLifetimeEffect()
	previous.reject(new Error('old owner settings read failed'))
	await oldRead
	expect(f.report).not.toHaveBeenCalled()
	expect(f.render('another-owner').error).toBeUndefined()
	f.startEligibilityEffect()
	await (reads.mock.results[1]?.value as Promise<void>)
	expect(f.render('another-owner').value).toEqual(newerChoice)
	expect(f.report).not.toHaveBeenCalled()
})

it('retires a committed departure without cancelling its newly returned refresh', async () => {
	const f = fixture()
	const previous = deferred<DraftSettings>()
	const current = deferred<DraftSettings>()
	const oldStarted = deferred<void>()
	const newStarted = deferred<void>()
	f.draftSettings
		.mockImplementationOnce(() => {
			oldStarted.resolve()
			return previous.promise
		})
		.mockImplementationOnce(() => {
			newStarted.resolve()
			return current.promise
		})
	const opening = f.render()
	const leave = f.startLifetimeEffect()
	const older = opening.refresh('session')
	const refused = expect(older).rejects.toThrow('message settings changed while loading')
	await oldStarted.promise
	f.render('another-owner')
	leave?.()
	const leaveOther = f.startLifetimeEffect()
	const returning = f.render()
	leaveOther?.()
	f.startLifetimeEffect()
	const newer = returning.refresh('session')
	await newStarted.promise
	// A repeated old cleanup cannot retire the newer same-ID read.
	leave?.()
	previous.reject(new Error('departed owner read failed'))
	await refused
	expect(f.report).not.toHaveBeenCalled()
	expect(f.render().loading).toBe(true)
	current.resolve(newerChoice)
	await newer
	expect(f.render().value).toEqual(newerChoice)
	expect(f.render().error).toBeUndefined()
	expect(f.report).not.toHaveBeenCalled()
})

it('keeps pending and queued writes bound to the API that admitted them after bridge replacement', async () => {
	const f = fixture()
	const firstStarted = deferred<void>()
	const firstWrite = deferred<void>()
	f.saveDraftSettings.mockImplementationOnce(() => {
		firstStarted.resolve()
		return firstWrite.promise
	})
	const opening = f.render()
	const leaveOld = f.startLifetimeEffect()
	const saving = opening.save('session', nativeChoice)
	await firstStarted.promise
	const queued = opening.save('session', newerChoice)
	const nextWrite = vi.fn<DesktopApi['saveDraftSettings']>().mockResolvedValue(undefined)
	const nextApi = {
		draftSettings: vi.fn<DesktopApi['draftSettings']>().mockResolvedValue({}),
		saveDraftSettings: nextWrite,
	} as unknown as DesktopApi
	const replacement = f.render('session', true, nextApi)
	leaveOld?.()
	f.startLifetimeEffect()
	await replacement.refresh('session')
	firstWrite.resolve()
	await Promise.all([saving, queued])
	expect(f.saveDraftSettings.mock.calls).toEqual([
		['session', nativeChoice],
		['session', newerChoice],
	])
	expect(nextWrite).not.toHaveBeenCalled()
	expect(f.render('session', true, nextApi).value).toEqual({})
	expect(f.report).not.toHaveBeenCalled()
})

it.each(['active', 'returning-owner', 'replaced-api'] as const)(
	'reports a deferred retry failure only to its still active owner and API (%s)',
	async (destination) => {
		const f = fixture()
		const started = deferred<void>()
		const write = deferred<void>()
		const originalError = new Error('initial settings save failed')
		const retryError = new Error('retry settings save failed')
		f.saveDraftSettings.mockRejectedValueOnce(originalError).mockImplementationOnce(() => {
			started.resolve()
			return write.promise
		})
		const opening = f.render()
		// StrictMode's setup replay must leave the current lifetime usable.
		f.startLifetimeEffect()?.()
		const leave = f.startLifetimeEffect()
		await expect(opening.save('session', nativeChoice)).rejects.toBe(originalError)
		const retries = vi.spyOn(DraftSettingsStore.prototype, 'retry')
		opening.retry()
		const retried = retries.mock.results[0]?.value as Promise<void>
		const rejected = expect(retried).rejects.toBe(retryError)
		await started.promise
		if (destination === 'returning-owner') {
			f.render('another-owner')
			leave?.()
			const leaveOther = f.startLifetimeEffect()
			f.render()
			leaveOther?.()
			f.startLifetimeEffect()
		} else if (destination === 'replaced-api') {
			// A committed replacement fences delivery before passive cleanup runs.
			f.render('session', true, {
				draftSettings: vi.fn().mockResolvedValue({}),
				saveDraftSettings: vi.fn().mockResolvedValue(undefined),
			} as unknown as DesktopApi)
			leave?.()
			f.startLifetimeEffect()
		}
		write.reject(retryError)
		await rejected
		if (destination === 'active') {
			expect(f.report).toHaveBeenCalledExactlyOnceWith(retryError)
			expect(f.render().value).toEqual(nativeChoice)
			expect(f.render().error).toBe('Message settings could not be saved. Try again.')
		} else expect(f.report).not.toHaveBeenCalled()
		expect(f.saveDraftSettings).toHaveBeenCalledTimes(2)
	},
)
