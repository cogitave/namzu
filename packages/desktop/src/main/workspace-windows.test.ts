import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceAction } from '../shared/protocol.js'
import {
	locateWorkspaceTab,
	parseWorkspaceLayout,
	workspaceGroups,
} from '../shared/workspace-layout.js'
import {
	WorkspaceWindowRegistry,
	WorkspaceWindows,
	clampWorkspaceBounds,
} from './workspace-windows.js'

function setup() {
	let id = 0
	const persisted: unknown[] = []
	const host = new WorkspaceWindows(
		undefined,
		() => `id-${++id}`,
		(layout) => persisted.push(layout),
	)
	host.addWindow('source')
	host.open('source', 'running-session')
	host.open('source', 'draft-session')
	return { host, persisted }
}

describe('main owned conversation workspace', () => {
	it('retires confirmed deleted views across windows while preserving every unrelated tab and window', () => {
		const { host } = setup()
		host.addWindow('other')
		host.open('other', 'pal-second-chat')
		host.open('other', 'unrelated')
		host.retireTabs(['running-session', 'pal-second-chat', 'not-open'])
		expect(host.snapshot().windows.map((window) => window.id)).toEqual(['source', 'other'])
		expect(locateWorkspaceTab(host.snapshot(), 'running-session')).toBeNull()
		expect(locateWorkspaceTab(host.snapshot(), 'pal-second-chat')).toBeNull()
		expect(locateWorkspaceTab(host.snapshot(), 'draft-session')?.windowId).toBe('source')
		expect(locateWorkspaceTab(host.snapshot(), 'unrelated')?.windowId).toBe('other')
	})

	it('cancels a retired tab’s detach and removes stale close-request IDs without accepting a late transfer ACK', () => {
		const { host } = setup()
		const transfer = host.beginDetach('source', 'running-session', 'home-source')
		host.retireTabs(['running-session'])
		expect(host.snapshot().windows.map((window) => window.id)).toEqual(['source'])
		expect(host.view('source').outgoingTransfer).toBeUndefined()
		expect(() => host.ready(transfer.destinationWindowId, transfer.id)).toThrow(
			'cannot acknowledge',
		)
		const close = host.beginClose('source')
		host.retireTabs(['draft-session'])
		expect(host.view('source').closingWindow).toEqual({ id: close, tabIds: [] })
		expect(host.snapshot().windows[0]?.root).toBeNull()
	})

	it('keeps the empty composer controller identity when its first session opens', () => {
		const host = new WorkspaceWindows(
			undefined,
			() => 'fresh',
			() => {},
		)
		host.addWindow('window')
		const empty = host.view('window')
		expect(host.action('window', { kind: 'focus', groupId: empty.homeGroupId })).toEqual(empty)
		host.open('window', 'first-session')
		expect(host.view('window').layout.windows[0]?.root?.id).toBe(empty.homeGroupId)
		expect(() => host.action('window', { kind: 'focus', groupId: 'home-foreign' })).toThrow()
	})
	it('preserves the source lease until the destination has acknowledged a native detach', () => {
		const { host, persisted } = setup()
		const before = host.snapshot()
		const transfer = host.beginDetach('source', 'running-session', 'home-source')
		expect(locateWorkspaceTab(host.snapshot(), 'running-session')).toEqual(
			locateWorkspaceTab(before, 'running-session'),
		)
		expect(host.view(transfer.destinationWindowId).pendingTransfer).toMatchObject({
			id: transfer.id,
			sourcePrepared: true,
		})
		expect(host.view(transfer.destinationWindowId).pendingTransfer?.previewRoot).toMatchObject({
			tabs: ['running-session'],
		})
		expect(() => host.assertOwner(transfer.destinationWindowId, 'running-session')).toThrow()
		expect(() => host.assertReadable(transfer.destinationWindowId, 'running-session')).not.toThrow()
		expect(parseWorkspaceLayout(persisted.at(-1))?.windows.map((item) => item.id)).toEqual([
			'source',
		])
		host.ready(transfer.destinationWindowId, transfer.id)
		expect(locateWorkspaceTab(host.snapshot(), 'running-session')?.windowId).toBe(
			transfer.destinationWindowId,
		)
		expect(() => host.assertOwner('source', 'running-session')).toThrow('moved')
		expect(() => host.assertOwner(transfer.destinationWindowId, 'running-session')).not.toThrow()
		expect(() => host.ready(transfer.destinationWindowId, transfer.id)).toThrow(
			'cannot acknowledge',
		)
	})
	it('rolls a failed native detach back without removing its source tab or admitting late acknowledgements', () => {
		const { host } = setup()
		const transfer = host.beginDetach('source', 'draft-session', 'home-source')
		host.rollback(transfer.id)
		expect(locateWorkspaceTab(host.snapshot(), 'draft-session')?.windowId).toBe('source')
		expect(host.snapshot().windows.map((item) => item.id)).toEqual(['source'])
		expect(() => host.assertOwner('source', 'draft-session')).not.toThrow()
		expect(() => host.ready(transfer.destinationWindowId, transfer.id)).toThrow()
	})
	it('requires source flush before exposing incoming snapshots or accepting destination readiness', () => {
		const { host } = setup()
		host.addWindow('destination')
		host.open('destination', 'other-session')
		const before = host.view('destination')
		host.action('destination', {
			kind: 'move',
			tabId: 'running-session',
			sourceWindowId: 'source',
			sourceGroupId: 'home-source',
			targetWindowId: 'destination',
			targetGroupId: 'home-destination',
			position: 'center',
		})
		const transfer = host.view('destination').pendingTransfer
		expect(transfer).toMatchObject({ sourcePrepared: false })
		expect(() => host.assertReadable('destination', 'running-session')).toThrow()
		expect(() => host.ready('destination', transfer?.id)).toThrow('still preparing')
		expect(() => host.assertOwner('source', 'running-session')).not.toThrow()
		expect(locateWorkspaceTab(host.snapshot(), 'running-session')?.windowId).toBe('source')
		host.ready('source', transfer?.id)
		expect(host.view('destination').pendingTransfer?.sourcePrepared).toBe(true)
		expect(host.view('source').outgoingTransfer?.prepared).toBe(true)
		expect(() => host.assertOwner('source', 'running-session')).toThrow('moving')
		expect(() => host.assertReadable('destination', 'running-session')).not.toThrow()
		expect(host.view('destination').sequence).toBeGreaterThan(before.sequence)
		host.ready('destination', transfer?.id)
		expect(locateWorkspaceTab(host.snapshot(), 'running-session')?.windowId).toBe('destination')
		expect(host.view('source').outgoingTransfer).toBeUndefined()
	})
	it('uses a separate monotonic sequence for preparation updates with the same layout revision', () => {
		const { host } = setup()
		host.addWindow('destination')
		host.action('source', {
			kind: 'move',
			tabId: 'running-session',
			sourceGroupId: 'home-source',
			targetWindowId: 'destination',
			targetGroupId: 'home-destination',
			position: 'center',
		})
		const unprepared = host.view('destination')
		host.ready('source', unprepared.pendingTransfer?.id)
		const prepared = host.view('destination')
		expect(prepared.layout.revision).toBe(unprepared.layout.revision)
		expect(prepared.sequence).toBeGreaterThan(unprepared.sequence)
	})
	it('refuses forged ownership, third window transfer commands and acknowledgements', () => {
		const { host } = setup()
		host.addWindow('destination')
		host.addWindow('third')
		expect(() =>
			host.action('third', {
				kind: 'move',
				tabId: 'running-session',
				sourceWindowId: 'source',
				sourceGroupId: 'home-source',
				targetWindowId: 'destination',
				targetGroupId: 'home-destination',
				position: 'center',
			}),
		).toThrow('cannot move')
		expect(() =>
			host.action('destination', {
				kind: 'move',
				tabId: 'running-session',
				sourceWindowId: 'destination',
				sourceGroupId: 'home-source',
				targetWindowId: 'third',
				targetGroupId: 'home-third',
				position: 'center',
			}),
		).toThrow('moved')
		const transfer = host.beginDetach('source', 'running-session', 'home-source')
		expect(() => host.ready('third', transfer.id)).toThrow('cannot acknowledge')
		expect(() =>
			host.action('third', { kind: 'cancel-transfer', transferId: transfer.id }),
		).toThrow('cannot cancel')
		expect(() => host.beginDetach('source', 'draft-session', 'home-source')).toThrow(
			'Finish moving',
		)
	})
	it('redocks all tabs on native close without closing the final saved layout', () => {
		const { host } = setup()
		const transfer = host.beginDetach('source', 'running-session', 'home-source')
		host.ready(transfer.destinationWindowId, transfer.id)
		host.closeWindow(transfer.destinationWindowId, 'source')
		expect(host.snapshot().windows.map((item) => item.id)).toEqual(['source'])
		expect(
			workspaceGroups(host.snapshot().windows[0]?.root ?? null).flatMap((item) => item.tabs),
		).toEqual(['draft-session', 'running-session'])
		host.closeWindow('source')
		expect(locateWorkspaceTab(host.persisted(), 'running-session')?.windowId).toBe('source')
	})
	it('aborts an unready native destination before redocking a closing source into a committed window', () => {
		const { host } = setup()
		host.addWindow('committed')
		const transfer = host.beginDetach('source', 'running-session', 'home-source')
		expect(host.pendingNativeWindows()).toEqual([transfer.destinationWindowId])
		host.closeWindow('source', 'committed')
		expect(host.snapshot().windows.map((item) => item.id)).toEqual(['committed'])
		expect(locateWorkspaceTab(host.snapshot(), 'running-session')?.windowId).toBe('committed')
		expect(locateWorkspaceTab(host.snapshot(), 'draft-session')?.windowId).toBe('committed')
	})
	it('aborts a renderer failure and returns the source lease without moving its saved draft identity', () => {
		const { host } = setup()
		const transfer = host.beginDetach('source', 'draft-session', 'home-source')
		host.abortTransfers(transfer.destinationWindowId)
		expect(host.pendingNativeWindows()).toEqual([])
		expect(() => host.assertOwner('source', 'draft-session')).not.toThrow()
		expect(locateWorkspaceTab(host.persisted(), 'draft-session')?.windowId).toBe('source')
	})
	it('rejects malformed restored state that grants multiple windows a writer lease', () => {
		const { host } = setup()
		const snapshot = host.snapshot()
		const invalid = {
			...snapshot,
			windows: [...snapshot.windows, { ...snapshot.windows[0], id: 'duplicate-window' }],
		}
		const restored = new WorkspaceWindows(
			invalid,
			() => 'fresh',
			() => {},
		)
		expect(restored.snapshot().windows).toEqual([])
		const valid = new WorkspaceWindows(
			host.persisted(),
			() => 'fresh',
			() => {},
		)
		expect(() => valid.assertOwner('source', 'draft-session')).not.toThrow()
	})
	it('refuses a split that cannot preserve readable pane dimensions', () => {
		const { host } = setup()
		expect(() =>
			host.action(
				'source',
				{
					kind: 'move',
					tabId: 'draft-session',
					sourceGroupId: 'home-source',
					targetWindowId: 'source',
					targetGroupId: 'home-source',
					position: 'right',
				},
				{ width: 700, height: 700 },
			),
		).toThrow('workspace changed')
		expect(locateWorkspaceTab(host.snapshot(), 'draft-session')?.groupId).toBe('home-source')
	})
	it('publishes a close request before revoking the source writer lease and admits only its own acknowledgement', () => {
		const { host } = setup()
		host.addWindow('destination')
		const previousSequence = host.view('source').sequence
		const closeId = host.beginClose('source')
		expect(host.view('source').closingWindow).toEqual({
			id: closeId,
			tabIds: ['running-session', 'draft-session'],
		})
		expect(host.view('source').sequence).toBeGreaterThan(previousSequence)
		expect(() => host.assertOwner('source', 'draft-session')).not.toThrow()
		expect(() => host.assertCloseReady('destination', closeId)).toThrow('cannot acknowledge')
		expect(() => host.assertCloseReady('source', 'stale-close')).toThrow('cannot acknowledge')
		expect(host.beginClose('source')).toBe(closeId)
		host.assertCloseReady('source', closeId)
		host.closeWindow('source', 'destination')
		expect(locateWorkspaceTab(host.snapshot(), 'draft-session')?.windowId).toBe('destination')
		expect(() => host.assertOwner('source', 'draft-session')).toThrow('moved')
	})
	it('immediately cancels a close after flush failure and preserves all source tabs', () => {
		const { host } = setup()
		const before = host.snapshot()
		const closeId = host.beginClose('source')
		expect(() => host.open('source', 'late-created-session')).toThrow('preparing to close')
		host.action('source', { kind: 'cancel-close', closeId })
		expect(host.view('source').closingWindow).toBeUndefined()
		expect(host.snapshot()).toEqual(before)
		expect(() => host.assertOwner('source', 'draft-session')).not.toThrow()
	})
	it('refuses layout changes during close preparation while retaining draft flush authority', () => {
		const { host } = setup()
		host.action('source', {
			kind: 'move',
			tabId: 'draft-session',
			sourceGroupId: 'home-source',
			targetWindowId: 'source',
			targetGroupId: 'home-source',
			position: 'right',
		})
		host.addWindow('destination')
		host.open('destination', 'existing-session')
		const sourceRoot = host.snapshot().windows.find((window) => window.id === 'source')?.root
		expect(sourceRoot?.kind).toBe('split')
		const closeId = host.beginClose('source')
		const before = host.snapshot()
		const actions: Exclude<WorkspaceAction, { kind: 'detach' }>[] = [
			{ kind: 'open', tabId: 'late-session' },
			{ kind: 'focus', groupId: 'home-source' },
			{ kind: 'activate', groupId: 'home-source', tabId: 'running-session' },
			{ kind: 'close', groupId: 'home-source', tabId: 'running-session' },
			{ kind: 'resize', splitId: sourceRoot?.id ?? '', ratio: 0.6 },
			{
				kind: 'move',
				tabId: 'running-session',
				sourceGroupId: 'home-source',
				targetWindowId: 'destination',
				targetGroupId: 'home-destination',
				position: 'center',
			},
		]
		for (const action of actions) {
			expect(() => host.action('source', action)).toThrow('preparing to close')
			expect(host.snapshot()).toEqual(before)
		}
		expect(() => host.beginDetach('source', 'running-session', 'home-source')).toThrow(
			'preparing to close',
		)
		expect(() => host.assertOwner('source', 'running-session')).not.toThrow()
		expect(() => host.assertProjectDraft('source', 'home-source', true)).not.toThrow()
		expect(() => host.assertCloseReady('source', closeId)).not.toThrow()
		expect(host.snapshot()).toEqual(before)
		host.action('source', { kind: 'cancel-close', closeId })
		host.action('source', { kind: 'activate', groupId: 'home-source', tabId: 'running-session' })
		expect(host.view('source').closingWindow).toBeUndefined()
		expect(host.snapshot().windows.find((window) => window.id === 'source')?.focusedGroupId).toBe(
			'home-source',
		)
	})
	it('refuses receiving or sending a transfer when either participating window is closing', () => {
		const { host } = setup()
		host.addWindow('destination')
		host.open('destination', 'existing-session')
		const move = {
			kind: 'move' as const,
			tabId: 'running-session',
			sourceWindowId: 'source',
			sourceGroupId: 'home-source',
			targetWindowId: 'destination',
			targetGroupId: 'home-destination',
			position: 'center' as const,
		}
		const sourceCloseId = host.beginClose('source')
		const sourceBefore = host.snapshot()
		expect(() => host.action('destination', move)).toThrow('preparing to close')
		expect(host.snapshot()).toEqual(sourceBefore)
		host.action('source', { kind: 'cancel-close', closeId: sourceCloseId })
		const destinationCloseId = host.beginClose('destination')
		const destinationBefore = host.snapshot()
		expect(() => host.action('source', move)).toThrow('preparing to close')
		expect(host.snapshot()).toEqual(destinationBefore)
		host.action('destination', { kind: 'cancel-close', closeId: destinationCloseId })
		host.action('source', move)
		expect(host.view('source').outgoingTransfer).toMatchObject({ tabId: 'running-session' })
		expect(host.view('destination').pendingTransfer).toMatchObject({
			tabId: 'running-session',
			sourcePrepared: false,
		})
	})
	it('rejects a stale project draft pane while retaining independent valid pane owners', () => {
		const { host } = setup()
		expect(() => host.assertProjectDraft('source', 'home-source')).not.toThrow()
		expect(() => host.assertProjectDraft('source', 'home-foreign')).toThrow(
			'another workspace pane',
		)
		host.addWindow('empty')
		expect(() => host.assertProjectDraft('empty', 'home-empty')).not.toThrow()
		expect(() => host.assertProjectDraft('unknown', 'home-unknown')).toThrow()
	})
	it('keeps a native destination read-only until its actual conversation is acknowledged', () => {
		const { host } = setup()
		const transfer = host.beginDetach('source', 'running-session', 'home-source')
		const destination = host.view(transfer.destinationWindowId)
		expect(() =>
			host.assertProjectDraft(destination.windowId, destination.homeGroupId, true),
		).toThrow()
		expect(() => host.open(destination.windowId, 'rogue-session', destination.homeGroupId)).toThrow(
			'still receiving',
		)
		expect(() => host.assertWindowWritable(destination.windowId)).toThrow()
		expect(() => host.assertReadable(destination.windowId, 'running-session')).not.toThrow()
		host.ready(destination.windowId, transfer.id)
		expect(() => host.assertWindowWritable(destination.windowId)).not.toThrow()
	})
	it('retains the original source membership if saving the acknowledged destination fails', () => {
		let id = 0
		let fail = false
		const persist = () => {
			if (fail) throw new Error('Simulated storage failure')
		}
		const host = new WorkspaceWindows(
			undefined,
			() => `fresh-${++id}`,
			() => {},
			persist,
		)
		host.addWindow('source')
		host.open('source', 'running-session')
		const transfer = host.beginDetach('source', 'running-session', 'home-source')
		fail = true
		expect(() => host.ready(transfer.destinationWindowId, transfer.id)).toThrow('storage failure')
		expect(locateWorkspaceTab(host.snapshot(), 'running-session')?.windowId).toBe('source')
		expect(host.hasTransfer(transfer.id)).toBe(true)
		fail = false
		host.rollback(transfer.id)
		expect(() => host.assertOwner('source', 'running-session')).not.toThrow()
	})
	it('retains an authenticated close intent and original tabs when saving the redocked layout fails', () => {
		let id = 0
		let fail = false
		const host = new WorkspaceWindows(
			undefined,
			() => `fresh-${++id}`,
			() => {},
			() => {
				if (fail) throw new Error('Simulated storage failure')
			},
		)
		host.addWindow('source')
		host.addWindow('destination')
		host.open('source', 'unsent-session')
		const closeId = host.beginClose('source')
		fail = true
		expect(() => host.closeWindow('source', 'destination')).toThrow('storage failure')
		expect(locateWorkspaceTab(host.snapshot(), 'unsent-session')?.windowId).toBe('source')
		expect(() => host.assertCloseReady('source', closeId)).not.toThrow()
		host.action('source', { kind: 'cancel-close', closeId })
		expect(host.view('source').closingWindow).toBeUndefined()
		expect(() => host.assertOwner('source', 'unsent-session')).not.toThrow()
	})
})

describe('registered privileged windows', () => {
	function window() {
		const mainFrame = { url: 'file:///namzu/index.html' }
		return {
			isDestroyed: vi.fn(() => false),
			webContents: {
				mainFrame,
				isDestroyed: vi.fn(() => false),
				send: vi.fn(),
			},
		}
	}
	it('authenticates only the registered contents, exact main frame and host-selected page', () => {
		const registry = new WorkspaceWindowRegistry<ReturnType<typeof window>>()
		const first = window()
		const second = window()
		registry.register('first', first)
		registry.register('second', second)
		expect(
			registry.authenticate(
				{ sender: second.webContents, senderFrame: second.webContents.mainFrame },
				'file:///namzu/index.html',
			).id,
		).toBe('second')
		for (const event of [
			{ sender: window().webContents, senderFrame: first.webContents.mainFrame },
			{ sender: first.webContents, senderFrame: { url: 'file:///namzu/index.html' } },
			{ sender: first.webContents, senderFrame: null },
		])
			expect(() => registry.authenticate(event, 'file:///namzu/index.html')).toThrow(
				'cannot control',
			)
		first.webContents.mainFrame.url = 'https://example.com/'
		expect(() =>
			registry.authenticate(
				{ sender: first.webContents, senderFrame: first.webContents.mainFrame },
				'file:///namzu/index.html',
			),
		).toThrow()
		registry.remove('second')
		expect(() =>
			registry.authenticate(
				{ sender: second.webContents, senderFrame: second.webContents.mainFrame },
				'file:///namzu/index.html',
			),
		).toThrow()
	})
	it('fans out each event exactly once to each live registered window', () => {
		const registry = new WorkspaceWindowRegistry<ReturnType<typeof window>>()
		const live = window()
		const dead = window()
		registry.register('live', live)
		registry.register('dead', dead)
		dead.webContents.isDestroyed.mockReturnValue(true)
		const event = { kind: 'state', sessionId: 'same-runtime', running: true }
		registry.fanout(event)
		expect(live.webContents.send).toHaveBeenCalledExactlyOnceWith('namzu:event', event)
		expect(dead.webContents.send).not.toHaveBeenCalled()
		expect(() => registry.register('live', window())).toThrow('already registered')
	})
	it('keeps ordered prompt and retirement delivery when another window disappears during send', () => {
		const registry = new WorkspaceWindowRegistry<ReturnType<typeof window>>()
		const disappearing = window()
		const healthy = window()
		const error = new Error('Window closed during delivery')
		disappearing.webContents.send.mockImplementation(() => {
			throw error
		})
		registry.register('disappearing', disappearing)
		registry.register('healthy', healthy)
		const failed = vi.fn()
		const prompt = { kind: 'prompt', sessionId: 'owner', revision: 1 }
		const retirement = {
			kind: 'attachment-previews-evicted',
			sessionId: 'owner',
			attachmentIds: ['image'],
			revision: 2,
		}
		registry.fanout(prompt, failed)
		registry.fanout(retirement, failed)
		expect(healthy.webContents.send.mock.calls).toEqual([
			['namzu:event', prompt],
			['namzu:event', retirement],
		])
		expect(failed.mock.calls).toEqual([[error], [error]])
	})
})

describe('restored native window bounds', () => {
	it('keeps the complete window inside a connected monitor after a monitor disappears', () => {
		expect(
			clampWorkspaceBounds({ x: 9000, y: -2000, width: 2000, height: 1400 }, [
				{ x: 0, y: 0, width: 1366, height: 768 },
			]),
		).toEqual({ x: 0, y: 0, width: 1366, height: 768 })
	})
	it('retains a connected negative-coordinate monitor and repairs invalid geometry', () => {
		const areas = [
			{ x: 0, y: 0, width: 1920, height: 1080 },
			{ x: -1920, y: 0, width: 1920, height: 1080 },
		]
		expect(clampWorkspaceBounds({ x: -1200, y: 100, width: 900, height: 700 }, areas)).toEqual({
			x: -1200,
			y: 100,
			width: 900,
			height: 700,
		})
		expect(clampWorkspaceBounds({ x: Number.NaN, y: 0, width: 0, height: -1 }, areas)).toEqual({
			x: 40,
			y: 40,
			width: 1180,
			height: 820,
		})
	})
})
