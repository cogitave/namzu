import { beforeEach, expect, it, vi } from 'vitest'
import type { AttachmentView, DesktopApi } from '../shared/protocol.js'
import { useAttachments } from './use-attachments.js'

// Exercise the actual hook's read and mutation handlers, choosing exactly when
// the owner effect starts or cleans up. No DOM timing or live IPC is involved.
const hooks = vi.hoisted(() => ({
	refs: [] as { current: unknown }[],
	refIndex: 0,
	states: [] as unknown[],
	stateIndex: 0,
	callbacks: [] as { value: unknown; dependencies: readonly unknown[] }[],
	callbackIndex: 0,
	setups: [] as (() => undefined | (() => void))[],
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
	useEffect(setup: () => undefined | (() => void)) {
		hooks.setups.push(setup)
	},
}))

beforeEach(() => {
	hooks.refs = []
	hooks.refIndex = 0
	hooks.states = []
	hooks.stateIndex = 0
	hooks.callbacks = []
	hooks.callbackIndex = 0
	hooks.setups = []
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
function file(id: string): AttachmentView {
	return { id, name: `${id}.txt`, kind: 'text', size: 5, mediaType: 'text/plain' }
}
function fixture() {
	const attachments = vi.fn<DesktopApi['attachments']>()
	const pickAttachments = vi.fn<DesktopApi['pickAttachments']>()
	const report = vi.fn()
	const api = { attachments, pickAttachments } as unknown as DesktopApi
	const render = (owner = 'session', connected = true, bridge = api) => {
		hooks.refIndex = 0
		hooks.stateIndex = 0
		hooks.callbackIndex = 0
		hooks.setups = []
		return useAttachments(owner, connected, report, bridge)
	}
	const startEligibilityEffect = () => hooks.setups[0]?.()
	const startLifetimeEffect = () => hooks.setups[1]?.()
	const startEffect = () => {
		const cleanups = hooks.setups.map((setup) => setup())
		return () => {
			for (const cleanup of cleanups) cleanup?.()
		}
	}
	return {
		attachments,
		pickAttachments,
		report,
		render,
		startEffect,
		startEligibilityEffect,
		startLifetimeEffect,
	}
}

it('keeps the selected owner opening reload admitted while history or harness readiness pauses', async () => {
	const { attachments, report, render, startEligibilityEffect, startLifetimeEffect } = fixture()
	const read = deferred<AttachmentView[]>()
	attachments.mockReturnValue(read.promise)
	const opening = render()
	const reload = opening.reload('session')
	const pauseEligibility = startEligibilityEffect()
	const leaveOwner = startLifetimeEffect()
	await Promise.resolve()
	// A harness switch reopens this same owner while pending history disables
	// automatic attachment reads. It must keep the explicit setup read alive.
	pauseEligibility?.()
	render('session', false)
	startEligibilityEffect()
	read.resolve([file('saved')])
	await reload
	expect(render('session', false).files).toEqual([file('saved')])
	expect(report).not.toHaveBeenCalled()
	render('session', true)
	startEligibilityEffect()
	expect(attachments).toHaveBeenCalledExactlyOnceWith('session')
	expect(render().loaded).toBe(true)
	leaveOwner?.()
})

it('keeps a reload started while readiness is paused when that same owner becomes ready', async () => {
	const { attachments, report, render, startEligibilityEffect, startLifetimeEffect } = fixture()
	const read = deferred<AttachmentView[]>()
	attachments.mockReturnValue(read.promise)
	const opening = render('session', false)
	startEligibilityEffect()
	const leaveOwner = startLifetimeEffect()
	const reload = opening.reload('session')
	render('session', true)
	startEligibilityEffect()
	await Promise.resolve()
	read.resolve([file('fresh')])
	await reload
	expect(render().files).toEqual([file('fresh')])
	expect(attachments).toHaveBeenCalledExactlyOnceWith('session')
	expect(report).not.toHaveBeenCalled()
	leaveOwner?.()
})

it('refuses a retired bridge snapshot even before its passive cleanup runs', async () => {
	const { attachments, report, render, startEffect } = fixture()
	const previous = deferred<AttachmentView[]>()
	const current = deferred<AttachmentView[]>()
	attachments.mockReturnValue(previous.promise)
	const opening = render()
	const reload = opening.reload('session')
	const refused = expect(reload).rejects.toThrow('attachments changed while loading')
	const cleanup = startEffect()
	const nextAttachments = vi.fn<DesktopApi['attachments']>().mockReturnValue(current.promise)
	const nextBridge = { attachments: nextAttachments } as unknown as DesktopApi
	// Rendering a replacement bridge fences its old response immediately; passive
	// cleanup must still retire the owner before a fresh read can be admitted.
	render('session', true, nextBridge)
	previous.resolve([file('retired')])
	await refused
	expect(render('session', true, nextBridge).files).toEqual([])
	const returning = render('session', true, nextBridge)
	const reloading = returning.reload('session')
	// The old bridge's delayed cleanup cannot retire a new bridge's same-owner read.
	cleanup?.()
	startEffect()
	current.resolve([file('current')])
	await reloading
	expect(render('session', true, nextBridge).files).toEqual([file('current')])
	expect(nextAttachments).toHaveBeenCalledExactlyOnceWith('session')
	// The active old read effect may report the refusal before cleanup. It cannot
	// publish or turn the retired files into the replacement bridge's snapshot.
	expect(report).toHaveBeenCalledOnce()
})

it('shares an explicit opening reload with the newly selected owner effect and admits files before it resolves', async () => {
	const { attachments, render, startEffect } = fixture()
	const read = deferred<AttachmentView[]>()
	attachments.mockReturnValue(read.promise)
	const opening = render()
	const reloading = opening.reload('session')
	startEffect()
	await Promise.resolve()
	expect(attachments).toHaveBeenCalledExactlyOnceWith('session')
	expect(render().loaded).toBe(false)
	read.resolve([file('saved')])
	await reloading
	expect(render().loaded).toBe(true)
	expect(render().files).toEqual([file('saved')])
	expect(opening.get('session')).toEqual([file('saved')])
})

it('shares an initial owner read with explicit reload, reports its failure, and permits a fresh retry', async () => {
	const { attachments, report, render, startEffect } = fixture()
	const read = deferred<AttachmentView[]>()
	const failure = new Error('Read refused')
	attachments.mockReturnValueOnce(read.promise).mockResolvedValueOnce([file('recovered')])
	const opening = render()
	startEffect()
	const reloading = opening.reload('session')
	const refused = expect(reloading).rejects.toBe(failure)
	read.reject(failure)
	await refused
	expect(attachments).toHaveBeenCalledExactlyOnceWith('session')
	expect(report).toHaveBeenCalledExactlyOnceWith(failure)
	expect(render().loaded).toBe(false)
	await opening.reload('session')
	expect(attachments).toHaveBeenCalledTimes(2)
	expect(render().files).toEqual([file('recovered')])
})

it('refreshes authoritative files on later explicit reloads while an admitted owner effect stays warm', async () => {
	const { attachments, render, startEffect } = fixture()
	attachments.mockResolvedValueOnce([file('before')]).mockResolvedValueOnce([file('after')])
	const opening = render()
	await opening.reload('session')
	startEffect()
	expect(attachments).toHaveBeenCalledOnce()
	await opening.reload('session')
	expect(attachments).toHaveBeenCalledTimes(2)
	expect(render().files).toEqual([file('after')])
})

it('rejects a read superseded by an admitted chooser result without replacing its files', async () => {
	const { attachments, pickAttachments, render, startEffect, report } = fixture()
	const read = deferred<AttachmentView[]>()
	const picked = deferred<AttachmentView[]>()
	attachments.mockReturnValue(read.promise)
	pickAttachments.mockReturnValue(picked.promise)
	const opening = render()
	const picking = opening.pick()
	const reloading = opening.reload('session')
	const refused = expect(reloading).rejects.toThrow('attachments changed while loading')
	startEffect()
	picked.resolve([file('authored')])
	await picking
	read.resolve([file('old')])
	await refused
	expect(render().files).toEqual([file('authored')])
	expect(report).not.toHaveBeenCalled()
})

it('starts a fresh read after a mutation begins and rejects the earlier snapshot', async () => {
	const { attachments, pickAttachments, render } = fixture()
	const before = deferred<AttachmentView[]>()
	const after = deferred<AttachmentView[]>()
	const picked = deferred<AttachmentView[]>()
	attachments.mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise)
	pickAttachments.mockReturnValue(picked.promise)
	const opening = render()
	const previous = opening.reload('session')
	const refused = expect(previous).rejects.toThrow('attachments changed while loading')
	const picking = opening.pick()
	const current = opening.reload('session')
	before.resolve([file('old')])
	await refused
	after.resolve([file('during')])
	await current
	expect(attachments).toHaveBeenCalledTimes(2)
	expect(render().files).toEqual([file('during')])
	picked.resolve([file('authored')])
	await picking
	expect(render().files).toEqual([file('authored')])
})

it('retires a pending owner read on cleanup and requires a fresh read when that owner returns', async () => {
	const { attachments, report, render, startEffect } = fixture()
	const previous = deferred<AttachmentView[]>()
	const current = deferred<AttachmentView[]>()
	attachments.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise)
	const opening = render()
	const older = opening.reload('session')
	const refused = expect(older).rejects.toThrow('attachments changed while loading')
	const cleanup = startEffect()
	cleanup?.()
	const returning = render()
	const reloading = returning.reload('session')
	startEffect()
	previous.resolve([file('old')])
	await refused
	expect(returning.get('session')).toEqual([])
	current.resolve([file('current')])
	await reloading
	expect(attachments).toHaveBeenCalledTimes(2)
	expect(render().files).toEqual([file('current')])
	expect(report).not.toHaveBeenCalled()
})
