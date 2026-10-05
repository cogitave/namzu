import { describe, expect, it, vi } from 'vitest'
import type { DesktopApi, DraftSettings } from '../shared/protocol.js'
import { createWorkspacePaneApi } from './workspace-pane-api.js'

function deferred<T>() {
	let resolve: (value: T | PromiseLike<T>) => void = () => {}
	let reject: (error: unknown) => void = () => {}
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

// Each case supplies the actual bridge methods it exercises. Missing methods
// stay missing instead of producing successful fake responses for unrelated work.
const bridge = (methods: Partial<DesktopApi>): DesktopApi => methods as DesktopApi

describe('pane write admission', () => {
	it('fences communication consent by its conversation owner and drains admitted metadata writes before transfer', async () => {
		const started = deferred<void>()
		const saved = deferred<Awaited<ReturnType<NonNullable<DesktopApi['updatePalPermission']>>>>()
		const updatePalPermission = vi
			.fn<NonNullable<DesktopApi['updatePalPermission']>>()
			.mockImplementation(() => {
				started.resolve()
				return saved.promise
			})
		let blocked = false
		const controller = createWorkspacePaneApi(bridge({ updatePalPermission }), {
			owns: (id) => id === 'owned',
			blocked: () => blocked,
		})
		const change = { snapshotId: 'snapshot', peerPalId: 'peer', enabled: true, allowWake: false }
		await expect(controller.api.updatePalPermission?.('foreign', 'pal', change)).rejects.toThrow(
			'another pane',
		)
		const pending = controller.api.updatePalPermission?.('owned', 'pal', change)
		change.allowWake = true
		await started.promise
		expect(updatePalPermission).toHaveBeenCalledExactlyOnceWith('owned', 'pal', {
			...change,
			allowWake: false,
		})
		blocked = true
		await expect(controller.api.updatePalPermission?.('owned', 'pal', change)).rejects.toThrow(
			'moving',
		)
		const flush = controller.flush()
		saved.resolve({
			palId: 'pal',
			snapshotId: 'fresh',
			supported: true,
			peers: [],
			messages: [],
			subscriptions: [],
			sources: [],
		})
		await pending
		await flush
		controller.invalidate()
		await expect(controller.api.updatePalPermission?.('owned', 'pal', change)).rejects.toThrow(
			'closed',
		)
		expect(updatePalPermission).toHaveBeenCalledTimes(1)
	})
	it('fences an explicit turn retry by pane ownership and transfer admission', async () => {
		const retryTurn = vi.fn<NonNullable<DesktopApi['retryTurn']>>().mockResolvedValue(undefined)
		let blocked = false
		const controller = createWorkspacePaneApi(bridge({ retryTurn }), {
			owns: (id) => id === 'owned',
			blocked: () => blocked,
		})
		await expect(controller.api.retryTurn?.('foreign', 'turn', 'checkpoint')).rejects.toThrow(
			'another pane',
		)
		blocked = true
		await expect(controller.api.retryTurn?.('owned', 'turn', 'checkpoint')).rejects.toThrow(
			'moving',
		)
		blocked = false
		await controller.api.retryTurn?.('owned', 'turn', 'checkpoint')
		expect(retryTurn).toHaveBeenCalledExactlyOnceWith('owned', 'turn', 'checkpoint', undefined)
		controller.invalidate()
		await expect(controller.api.retryTurn?.('owned', 'turn', 'checkpoint')).rejects.toThrow(
			'closed',
		)
	})

	it('copies a frozen context bridge and blocks another pane without mutating the original API', async () => {
		const saveDraft = vi.fn<DesktopApi['saveDraft']>().mockResolvedValue(undefined)
		const original = Object.freeze(bridge({ saveDraft }))
		const controller = createWorkspacePaneApi(original, {
			owns: (id) => id === 'owned',
			blocked: () => false,
		})
		await controller.api.saveDraft('owned', 'kept')
		await expect(controller.api.saveDraft('other-pane', 'wrong')).rejects.toThrow('another pane')
		expect(saveDraft).toHaveBeenCalledExactlyOnceWith('owned', 'kept')
		expect(original.saveDraft).toBe(saveDraft)
		expect(controller.api.saveDraft).not.toBe(saveDraft)
	})

	it('keeps pending previews readable while refusing conversation, project and Pal mutations', async () => {
		const draft = vi.fn<DesktopApi['draft']>().mockResolvedValue('existing draft')
		const openConversation = vi
			.fn<DesktopApi['openConversation']>()
			.mockResolvedValue({ messages: [], partial: false })
		const saveDraft = vi.fn<DesktopApi['saveDraft']>().mockResolvedValue(undefined)
		const startPalComputer = vi
			.fn<DesktopApi['startPalComputer']>()
			.mockResolvedValue({ status: 'ready' })
		const controller = createWorkspacePaneApi(
			bridge({ draft, openConversation, saveDraft, startPalComputer }),
			{
				owns: () => true,
				blocked: () => true,
			},
		)
		expect(await controller.api.draft('preview')).toBe('existing draft')
		await controller.api.openConversation('project', 'preview')
		await expect(controller.api.saveDraft('preview', 'changed')).rejects.toThrow('moving')
		await expect(controller.api.saveDraft('project:project', 'changed')).rejects.toThrow('moving')
		await expect(controller.api.startPalComputer('pal')).rejects.toThrow('moving')
		expect(saveDraft).not.toHaveBeenCalled()
		expect(startPalComputer).not.toHaveBeenCalled()
		expect(controller.api.selectHarness).toBeUndefined()
	})

	it('guards both attachment owners and all conversation control mutations', async () => {
		const moveAttachments = vi.fn<DesktopApi['moveAttachments']>().mockResolvedValue([])
		const send = vi.fn<DesktopApi['send']>().mockResolvedValue(undefined)
		const approve = vi.fn<DesktopApi['approve']>().mockResolvedValue(undefined)
		const selectHarness = vi
			.fn<NonNullable<DesktopApi['selectHarness']>>()
			.mockResolvedValue({ selected: 'namzu', locked: false, engines: [] })
		const controller = createWorkspacePaneApi(
			bridge({ moveAttachments, send, approve, selectHarness }),
			{
				owns: (id) => id === 'owned',
				blocked: () => false,
			},
		)
		await expect(controller.api.moveAttachments('owned', 'other')).rejects.toThrow('another pane')
		await expect(controller.api.moveAttachments('other', 'owned')).rejects.toThrow('another pane')
		await controller.api.moveAttachments('project:p', 'owned')
		await expect(controller.api.send('other', 'wrong')).rejects.toThrow('another pane')
		await expect(controller.api.approve('other', 'request', true)).rejects.toThrow('another pane')
		await expect(controller.api.selectHarness?.('other', 'namzu')).rejects.toThrow('another pane')
		expect(moveAttachments).toHaveBeenCalledExactlyOnceWith('project:p', 'owned')
		expect(send).not.toHaveBeenCalled()
		expect(approve).not.toHaveBeenCalled()
		expect(selectHarness).not.toHaveBeenCalled()
	})

	it('allows an ordinary project draft before session creation and denies global edits in a read-only view', async () => {
		const saveDraft = vi.fn<DesktopApi['saveDraft']>().mockResolvedValue(undefined)
		const createPal = vi.fn<DesktopApi['createPal']>()
		const controller = createWorkspacePaneApi(bridge({ saveDraft, createPal }), {
			owns: () => false,
			blocked: () => false,
			allowGlobalMutations: () => false,
		})
		await controller.api.saveDraft('project:p', 'first draft')
		await expect(controller.api.createPal({ name: 'Pal' })).rejects.toThrow('read-only')
		expect(createPal).not.toHaveBeenCalled()
	})
})

describe('pane persistence and transfer flush', () => {
	it('serializes an owner’s draft and choices, draining admitted writes after freezing new work', async () => {
		const firstStarted = deferred<void>()
		const firstSaved = deferred<void>()
		const secondStarted = deferred<void>()
		const secondSaved = deferred<void>()
		const writes: string[] = []
		let blocked = false
		const saveDraft = vi.fn<DesktopApi['saveDraft']>(async (_id, value) => {
			writes.push(value)
			firstStarted.resolve()
			await firstSaved.promise
		})
		const saveDraftSettings = vi.fn<DesktopApi['saveDraftSettings']>(async () => {
			writes.push('choices')
			secondStarted.resolve()
			await secondSaved.promise
		})
		const controller = createWorkspacePaneApi(bridge({ saveDraft, saveDraftSettings }), {
			owns: () => true,
			blocked: () => blocked,
		})
		const first = controller.api.saveDraft('a', 'latest draft')
		const second = controller.api.saveDraftSettings('a', { options: { effort: 'high' } })
		await firstStarted.promise
		expect(writes).toEqual(['latest draft'])
		blocked = true
		let flushed = false
		const flushing = controller.flush().then(() => {
			flushed = true
		})
		await expect(controller.api.saveDraft('a', 'after freeze')).rejects.toThrow('moving')
		firstSaved.resolve()
		await secondStarted.promise
		expect(flushed).toBe(false)
		secondSaved.resolve()
		await Promise.all([first, second, flushing])
		expect(writes).toEqual(['latest draft', 'choices'])
		expect(flushed).toBe(true)
	})

	it('lets different owners persist independently while preserving each owner’s latest text', async () => {
		const firstStarted = deferred<void>()
		const firstSaved = deferred<void>()
		const saved = new Map<string, string>()
		const saveDraft = vi.fn<DesktopApi['saveDraft']>(async (id, value) => {
			if (id === 'a' && value === 'old') {
				firstStarted.resolve()
				await firstSaved.promise
			}
			saved.set(id, value)
		})
		const controller = createWorkspacePaneApi(bridge({ saveDraft }), {
			owns: () => true,
			blocked: () => false,
		})
		const old = controller.api.saveDraft('a', 'old')
		const latest = controller.api.saveDraft('a', 'latest')
		await firstStarted.promise
		await controller.api.saveDraft('b', 'independent')
		expect(saved.get('b')).toBe('independent')
		expect(saved.has('a')).toBe(false)
		firstSaved.resolve()
		await Promise.all([old, latest, controller.flush()])
		expect(saved.get('a')).toBe('latest')
	})

	it('retains a failed save after it settles and only a successful retry of that owner/category clears it', async () => {
		const failure = new Error('disk write failed')
		const saveDraft = vi
			.fn<DesktopApi['saveDraft']>()
			.mockRejectedValueOnce(failure)
			.mockResolvedValue(undefined)
		const saveDraftSettings = vi.fn<DesktopApi['saveDraftSettings']>().mockResolvedValue(undefined)
		const controller = createWorkspacePaneApi(bridge({ saveDraft, saveDraftSettings }), {
			owns: () => true,
			blocked: () => false,
		})
		await expect(controller.api.saveDraft('a', 'unsaved')).rejects.toBe(failure)
		await expect(controller.flush()).rejects.toBe(failure)
		await controller.api.saveDraft('b', 'unrelated')
		await controller.api.saveDraftSettings('a', { options: { effort: 'low' } })
		await expect(controller.flush()).rejects.toBe(failure)
		await controller.api.saveDraft('a', 'retry retained text')
		await expect(controller.flush()).resolves.toBeUndefined()
	})

	it('does not fail a transfer for an older failed save when a queued newer save succeeds', async () => {
		const fail = deferred<void>()
		const started = deferred<void>()
		const saveDraft = vi
			.fn<DesktopApi['saveDraft']>()
			.mockImplementationOnce(async () => {
				started.resolve()
				await fail.promise
			})
			.mockResolvedValue(undefined)
		const controller = createWorkspacePaneApi(bridge({ saveDraft }), {
			owns: () => true,
			blocked: () => false,
		})
		const old = controller.api.saveDraft('a', 'old')
		const rejected = expect(old).rejects.toThrow('older failure')
		const latest = controller.api.saveDraft('a', 'new')
		await started.promise
		const flushing = controller.flush()
		fail.reject(new Error('older failure'))
		await Promise.all([rejected, latest, flushing])
		expect(saveDraft).toHaveBeenLastCalledWith('a', 'new')
	})

	it('captures settings at admission so a later object edit cannot change the persisted choice', async () => {
		const saveDraftSettings = vi.fn<DesktopApi['saveDraftSettings']>().mockResolvedValue(undefined)
		const controller = createWorkspacePaneApi(bridge({ saveDraftSettings }), {
			owns: () => true,
			blocked: () => false,
		})
		const settings: DraftSettings = {
			choice: { provider: 'zen', model: 'original' },
			options: { effort: 'high' },
		}
		const save = controller.api.saveDraftSettings('a', settings)
		settings.choice!.model = 'mutated'
		settings.options!.effort = 'low'
		await save
		expect(saveDraftSettings).toHaveBeenCalledWith('a', {
			choice: { provider: 'zen', model: 'original' },
			options: { effort: 'high' },
		})
	})

	it('rechecks the canonical lease before a queued write reaches main', async () => {
		const started = deferred<void>()
		const saved = deferred<void>()
		let owned = true
		const saveDraft = vi.fn<DesktopApi['saveDraft']>(async () => {
			started.resolve()
			await saved.promise
		})
		const controller = createWorkspacePaneApi(bridge({ saveDraft }), {
			owns: () => owned,
			blocked: () => false,
		})
		const admitted = controller.api.saveDraft('a', 'admitted')
		const queued = controller.api.saveDraft('a', 'stale')
		const rejected = expect(queued).rejects.toThrow('another pane')
		await started.promise
		owned = false
		saved.resolve()
		await Promise.all([admitted, rejected])
		expect(saveDraft).toHaveBeenCalledExactlyOnceWith('a', 'admitted')
		await expect(controller.flush()).rejects.toThrow('another pane')
	})

	it('invalidates a closed view without letting its queued callbacks mutate the new owner', async () => {
		const started = deferred<void>()
		const saved = deferred<void>()
		const saveDraft = vi.fn<DesktopApi['saveDraft']>(async () => {
			started.resolve()
			await saved.promise
		})
		const controller = createWorkspacePaneApi(bridge({ saveDraft }), {
			owns: () => true,
			blocked: () => false,
		})
		const admitted = controller.api.saveDraft('a', 'admitted')
		const queued = controller.api.saveDraft('a', 'stale')
		const rejected = expect(queued).rejects.toThrow('closed')
		await started.promise
		controller.invalidate()
		await expect(controller.api.saveDraft('a', 'new')).rejects.toThrow('closed')
		saved.resolve()
		await Promise.all([admitted, rejected])
		expect(saveDraft).toHaveBeenCalledExactlyOnceWith('a', 'admitted')
	})
	it('reactivates an effect lifetime while retiring the previous lifetime’s queued callbacks', async () => {
		const saveDraft = vi.fn<DesktopApi['saveDraft']>().mockResolvedValue(undefined)
		const createPal = vi.fn<DesktopApi['createPal']>()
		const controller = createWorkspacePaneApi(bridge({ saveDraft, createPal }), {
			owns: () => true,
			blocked: () => false,
		})
		const stale = controller.api.saveDraft('project:p', 'stale effect')
		const rejected = expect(stale).rejects.toThrow('closed')
		controller.invalidate()
		await expect(controller.api.createPal({ name: 'Closed' })).rejects.toThrow('closed')
		controller.activate()
		await controller.api.saveDraft('project:p', 'current effect')
		await rejected
		await controller.flush()
		expect(saveDraft).toHaveBeenCalledExactlyOnceWith('project:p', 'current effect')
		expect(createPal).not.toHaveBeenCalled()
	})
	it('does not grant a created session to a reactivated pane when its native creation belongs to an older lifetime', async () => {
		const started = deferred<void>()
		const completed = deferred<Awaited<ReturnType<DesktopApi['newConversation']>>>()
		const newConversation = vi.fn<DesktopApi['newConversation']>(async () => {
			started.resolve()
			return completed.promise
		})
		const created = vi.fn()
		const controller = createWorkspacePaneApi(bridge({ newConversation }), {
			owns: () => true,
			blocked: () => false,
			created,
		})
		const old = controller.api.newConversation('p')
		const rejected = expect(old).rejects.toThrow('closed')
		await started.promise
		controller.invalidate()
		controller.activate()
		completed.resolve({ id: 'old', projectId: 'p', title: 'Old', updatedAt: '2026-10-04' })
		await rejected
		expect(created).not.toHaveBeenCalled()
	})

	it('waits for attachment/engine dispatch acknowledgments and exposes a failure during the flush', async () => {
		const started = deferred<void>()
		const selection = deferred<void>()
		const failure = new Error('selection failed')
		const selectProvider = vi.fn<DesktopApi['selectProvider']>(async () => {
			started.resolve()
			await selection.promise
		})
		const controller = createWorkspacePaneApi(bridge({ selectProvider }), {
			owns: () => true,
			blocked: () => false,
		})
		const changing = controller.api.selectProvider('a', 'zen', 'model')
		const rejected = expect(changing).rejects.toBe(failure)
		await started.promise
		const flushing = expect(controller.flush()).rejects.toBe(failure)
		selection.reject(failure)
		await Promise.all([rejected, flushing])
	})
})

it('focuses the originating group before creating a session and grants provisional ownership before delivery', async () => {
	const focus = deferred<void>()
	const created = new Set<string>()
	const newConversation = vi.fn<DesktopApi['newConversation']>().mockResolvedValue({
		id: 'new',
		projectId: 'p',
		title: 'New conversation',
		updatedAt: '2026-10-04',
	})
	const saveDraft = vi.fn<DesktopApi['saveDraft']>().mockResolvedValue(undefined)
	const controller = createWorkspacePaneApi(bridge({ newConversation, saveDraft }), {
		owns: (id) => created.has(id),
		blocked: () => false,
		beforeNewConversation: () => focus.promise,
		created: (id) => {
			created.add(id)
		},
	})
	const creating = controller.api.newConversation('p')
	await Promise.resolve()
	expect(newConversation).not.toHaveBeenCalled()
	focus.resolve()
	const conversation = await creating
	await controller.api.saveDraft(conversation.id, 'first message')
	await controller.flush()
	expect(created.has('new')).toBe(true)
	expect(saveDraft).toHaveBeenCalledExactlyOnceWith('new', 'first message')
})
