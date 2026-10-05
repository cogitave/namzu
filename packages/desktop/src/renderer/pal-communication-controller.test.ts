import { expect, it, vi } from 'vitest'
import type { PalCommunicationView } from '../shared/pal-communication-protocol.js'
import type { DesktopApi } from '../shared/protocol.js'
import { PalCommunicationController } from './pal-communication-controller.js'

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
const view = (snapshotId: string): PalCommunicationView => ({
	palId: 'one',
	snapshotId,
	supported: true,
	peers: [],
	messages: [],
	subscriptions: [],
	sources: [],
})
const bridge = (methods: Partial<DesktopApi>) => methods as DesktopApi
it('does not resurrect closed data and handles React effect replay with a new read lifetime', async () => {
	const old = deferred<PalCommunicationView>()
	const fresh = deferred<PalCommunicationView>()
	const read = vi
		.fn<NonNullable<DesktopApi['palCommunication']>>()
		.mockReturnValueOnce(old.promise)
		.mockReturnValueOnce(fresh.promise)
	const controller = new PalCommunicationController(
		bridge({ palCommunication: read }),
		'session',
		'one',
	)
	const first = controller.load()
	controller.dispose()
	controller.activate()
	const second = controller.load()
	fresh.resolve(view('fresh'))
	await second
	old.resolve(view('old'))
	await first
	expect(controller.getSnapshot().view?.snapshotId).toBe('fresh')
	controller.dispose()
	await controller.load()
	expect(read).toHaveBeenCalledTimes(2)
})
it('retains failed reads, blocks edits until refresh, and never implicitly retries an ambiguous change', async () => {
	const read = vi
		.fn<NonNullable<DesktopApi['palCommunication']>>()
		.mockResolvedValueOnce(view('first'))
		.mockRejectedValueOnce(new Error('PRIVATE'))
		.mockResolvedValueOnce(view('next'))
	const update = vi
		.fn<NonNullable<DesktopApi['updatePalPermission']>>()
		.mockRejectedValue(new Error('Uncertain PRIVATE'))
	const controller = new PalCommunicationController(
		bridge({ palCommunication: read, updatePalPermission: update }),
		'session',
		'one',
	)
	await controller.load()
	await controller.load()
	expect(controller.getSnapshot()).toMatchObject({
		view: { snapshotId: 'first' },
		needsRefresh: true,
	})
	await controller.permission({ peerPalId: 'two', enabled: true, allowWake: false })
	expect(update).not.toHaveBeenCalled()
	await controller.load()
	await controller.permission({ peerPalId: 'two', enabled: true, allowWake: false })
	expect(update).toHaveBeenCalledExactlyOnceWith('session', 'one', {
		snapshotId: 'next',
		peerPalId: 'two',
		enabled: true,
		allowWake: false,
	})
	await controller.permission({ peerPalId: 'two', enabled: true, allowWake: false })
	expect(update).toHaveBeenCalledTimes(1)
	expect(controller.getSnapshot().error).not.toContain('PRIVATE')
})
it('serializes changes and does not refresh or apply late mutation results after the dialog closes', async () => {
	const operation = deferred<PalCommunicationView>()
	const read = vi.fn<NonNullable<DesktopApi['palCommunication']>>().mockResolvedValue(view('first'))
	const update = vi
		.fn<NonNullable<DesktopApi['updatePalPermission']>>()
		.mockReturnValue(operation.promise)
	const controller = new PalCommunicationController(
		bridge({ palCommunication: read, updatePalPermission: update }),
		'session',
		'one',
	)
	await controller.load()
	const pending = controller.permission({ peerPalId: 'two', enabled: true, allowWake: false })
	await controller.permission({ peerPalId: 'two', enabled: true, allowWake: true })
	await controller.load()
	expect(update).toHaveBeenCalledTimes(1)
	expect(read).toHaveBeenCalledTimes(1)
	controller.dispose()
	operation.resolve(view('late'))
	await pending
	expect(controller.getSnapshot().view?.snapshotId).toBe('first')
})
