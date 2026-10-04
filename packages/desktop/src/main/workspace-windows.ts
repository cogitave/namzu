import type { WorkspaceAction, WorkspaceView } from '../shared/protocol.js'
import {
	type WorkspaceLayoutSnapshot,
	type WorkspaceMoveTab,
	type WorkspaceWindowBounds,
	activateWorkspaceTab,
	addWorkspaceWindow,
	closeWorkspaceTab,
	findWorkspaceGroup,
	locateWorkspaceTab,
	moveWorkspaceTab,
	openWorkspaceTab,
	parseWorkspaceLayout,
	removeWorkspaceWindow,
	resizeWorkspaceSplit,
	workspaceGroups,
} from '../shared/workspace-layout.js'

interface Transfer {
	id: string
	tabId: string
	sourceWindowId: string
	sourceGroupId: string
	destinationWindowId: string
	groupId: string
	move: WorkspaceMoveTab
	nativeWindow: boolean
	sourceReady: boolean
	destinationReady: boolean
}

/** Layout membership is the writer lease. Runtime sessions themselves never move or restart. */
export class WorkspaceWindows {
	private layout: WorkspaceLayoutSnapshot
	private sequence = 0
	private readonly transfers = new Map<string, Transfer>()
	private readonly closing = new Map<string, { id: string; tabIds: string[] }>()
	constructor(
		input: unknown,
		private readonly id: () => string,
		private readonly changed: (layout: WorkspaceLayoutSnapshot) => void,
		private readonly persist?: (layout: WorkspaceLayoutSnapshot) => void,
	) {
		this.layout = parseWorkspaceLayout(input) ?? { version: 1, revision: 0, windows: [] }
	}
	snapshot(): WorkspaceLayoutSnapshot {
		return structuredClone(this.layout)
	}
	hasTransfer(id: string): boolean {
		return this.transfers.has(id)
	}
	abortTransfers(windowId: string): void {
		for (const transfer of [...this.transfers.values()])
			if (transfer.sourceWindowId === windowId || transfer.destinationWindowId === windowId)
				this.rollback(transfer.id)
	}
	pendingNativeWindows(windowId?: string): string[] {
		return [...this.transfers.values()]
			.filter(
				(item) =>
					item.nativeWindow &&
					(!windowId || item.sourceWindowId === windowId || item.destinationWindowId === windowId),
			)
			.map((item) => item.destinationWindowId)
	}
	beginClose(windowId: string): string {
		this.view(windowId)
		const existing = this.closing.get(windowId)
		if (existing) return existing.id
		this.abortTransfers(windowId)
		const window = this.layout.windows.find((item) => item.id === windowId)
		if (!window) throw new Error('This window cannot control Namzu.')
		const close = {
			id: this.id(),
			tabIds: workspaceGroups(window.root).flatMap((item) => item.tabs),
		}
		this.closing.set(windowId, close)
		this.publish()
		return close.id
	}
	assertCloseReady(windowId: string, closeId: unknown): void {
		if (typeof closeId !== 'string' || this.closing.get(windowId)?.id !== closeId)
			throw new Error('This window cannot acknowledge that close request.')
	}
	cancelClose(windowId: string): void {
		if (this.closing.delete(windowId)) this.publish()
	}
	private commit(next: WorkspaceLayoutSnapshot | null): void {
		if (!next) throw new Error('This workspace changed. Try the action again.')
		if (next === this.layout) return
		this.persist?.(this.persistentSnapshot(next))
		this.layout = next
		this.publish()
	}
	private publish(): void {
		this.sequence++
		this.changed(this.persisted())
	}
	/** Unacknowledged windows are not restored as owners after a host crash. */
	persisted(): WorkspaceLayoutSnapshot {
		return this.persistentSnapshot(this.layout)
	}
	private persistentSnapshot(layout: WorkspaceLayoutSnapshot): WorkspaceLayoutSnapshot {
		const pending = new Set(
			[...this.transfers.values()]
				.filter((item) => item.nativeWindow)
				.map((item) => item.destinationWindowId),
		)
		return structuredClone({
			...layout,
			windows: layout.windows.filter((item) => !pending.has(item.id)),
		})
	}
	addWindow(windowId: string, bounds?: WorkspaceWindowBounds): void {
		if (this.layout.windows.some((item) => item.id === windowId)) return
		this.commit(addWorkspaceWindow(this.layout, { id: windowId, bounds }))
	}
	view(windowId: string): WorkspaceView {
		if (!this.layout.windows.some((item) => item.id === windowId))
			throw new Error('This window cannot control Namzu.')
		const transfer = [...this.transfers.values()].find(
			(item) => item.destinationWindowId === windowId,
		)
		const preview = transfer ? this.transferLayout(transfer) : undefined
		const previewRoot = preview?.windows.find((item) => item.id === windowId)?.root
		const outgoing = [...this.transfers.values()].find((item) => item.sourceWindowId === windowId)
		return {
			windowId,
			sequence: this.sequence,
			homeGroupId: `home-${windowId}`,
			layout: this.snapshot(),
			...(transfer && previewRoot
				? {
						pendingTransfer: {
							id: transfer.id,
							tabId: transfer.tabId,
							sourceWindowId: transfer.sourceWindowId,
							destinationWindowId: transfer.destinationWindowId,
							sourcePrepared: transfer.sourceReady,
							previewRoot: structuredClone(previewRoot),
						},
					}
				: {}),
			...(outgoing
				? {
						outgoingTransfer: {
							id: outgoing.id,
							tabId: outgoing.tabId,
							destinationWindowId: outgoing.destinationWindowId,
							prepared: outgoing.sourceReady,
						},
					}
				: {}),
			...(this.closing.has(windowId)
				? { closingWindow: structuredClone(this.closing.get(windowId)) }
				: {}),
		}
	}
	assertOwner(windowId: string, tabId: unknown): void {
		if (typeof tabId !== 'string' || locateWorkspaceTab(this.layout, tabId)?.windowId !== windowId)
			throw new Error('This conversation moved to another window. Open it there to continue.')
		if ([...this.transfers.values()].some((item) => item.tabId === tabId && item.sourceReady))
			throw new Error('This conversation is moving to another window.')
	}
	assertWindowWritable(windowId: string): void {
		this.view(windowId)
		if (this.pendingNativeWindows().includes(windowId))
			throw new Error('This window is still receiving its conversation.')
	}
	assertReadable(windowId: string, tabId: unknown): void {
		if (
			typeof tabId === 'string' &&
			[...this.transfers.values()].some(
				(item) => item.destinationWindowId === windowId && item.tabId === tabId && item.sourceReady,
			)
		)
			return
		if (typeof tabId !== 'string' || locateWorkspaceTab(this.layout, tabId)?.windowId !== windowId)
			throw new Error('This conversation moved to another window. Open it there to continue.')
	}
	assertProjectDraft(windowId: string, groupId: string, write = false): void {
		if (write) this.assertWindowWritable(windowId)
		const window = this.layout.windows.find((item) => item.id === windowId)
		const incoming = [...this.transfers.values()].find(
			(item) => item.destinationWindowId === windowId && item.sourceReady,
		)
		const preview =
			incoming && this.transferLayout(incoming)?.windows.find((item) => item.id === windowId)?.root
		const canonicalGroup =
			window &&
			(findWorkspaceGroup(window.root, groupId) || (!window.root && groupId === `home-${windowId}`))
		if (
			write &&
			incoming &&
			(incoming.nativeWindow || !canonicalGroup) &&
			findWorkspaceGroup(preview || null, groupId)
		)
			throw new Error('This draft is preparing to move to another window.')
		if (
			write &&
			[...this.transfers.values()].some(
				(item) =>
					item.sourceWindowId === windowId && item.sourceReady && item.sourceGroupId === groupId,
			)
		)
			throw new Error('This draft is preparing to move to another window.')
		if (
			!window ||
			!(
				findWorkspaceGroup(window.root, groupId) ||
				(!write && findWorkspaceGroup(preview || null, groupId)) ||
				(!window.root && groupId === `home-${windowId}`)
			)
		)
			throw new Error('This draft belongs to another workspace pane.')
	}
	private assertUnreserved(tabId: string): void {
		if ([...this.transfers.values()].some((item) => item.tabId === tabId))
			throw new Error('This conversation is moving to another window.')
	}
	private assertNotClosing(...windowIds: string[]): void {
		if (windowIds.some((windowId) => this.closing.has(windowId)))
			throw new Error('This window is preparing to close.')
	}
	open(windowId: string, tabId: string, groupId?: string): void {
		this.assertWindowWritable(windowId)
		this.assertNotClosing(windowId)
		if (groupId) this.assertProjectDraft(windowId, groupId)
		const owner = locateWorkspaceTab(this.layout, tabId)
		if (owner && owner.windowId !== windowId)
			throw new Error('This conversation is open in another window. Move its tab to use it here.')
		if (owner) {
			this.commit(activateWorkspaceTab(this.layout, { windowId, tabId, groupId: owner.groupId }))
			return
		}
		this.commit(
			openWorkspaceTab(this.layout, { windowId, tabId, groupId, newGroupId: `home-${windowId}` }),
		)
	}
	action(
		windowId: string,
		action: Exclude<WorkspaceAction, { kind: 'detach' }>,
		targetSize?: { width: number; height: number },
	): WorkspaceView {
		if (!action || typeof action !== 'object') throw new Error('Invalid workspace action.')
		this.view(windowId)
		if (action.kind !== 'cancel-close' && action.kind !== 'cancel-transfer')
			this.assertNotClosing(windowId)
		switch (action.kind) {
			case 'cancel-close':
				this.assertCloseReady(windowId, action.closeId)
				this.cancelClose(windowId)
				break
			case 'cancel-transfer': {
				const transfer = this.transfers.get(action.transferId)
				if (
					!transfer ||
					(transfer.sourceWindowId !== windowId && transfer.destinationWindowId !== windowId)
				)
					throw new Error('This window cannot cancel that conversation move.')
				this.rollback(action.transferId)
				break
			}
			case 'open':
				this.open(windowId, action.tabId, action.groupId)
				break
			case 'focus': {
				const window = this.layout.windows.find((item) => item.id === windowId)
				if (window && !window.root && action.groupId === `home-${windowId}`) break
				if (!window || !findWorkspaceGroup(window.root, action.groupId))
					throw new Error('Unknown workspace group.')
				if (window.focusedGroupId !== action.groupId)
					this.commit(
						parseWorkspaceLayout({
							...this.layout,
							revision: this.layout.revision + 1,
							windows: this.layout.windows.map((item) =>
								item === window ? { ...item, focusedGroupId: action.groupId } : item,
							),
						}),
					)
				break
			}
			case 'activate':
				this.assertWindowWritable(windowId)
				this.assertOwner(windowId, action.tabId)
				this.commit(
					activateWorkspaceTab(this.layout, {
						windowId,
						groupId: action.groupId,
						tabId: action.tabId,
					}),
				)
				break
			case 'close':
				this.assertWindowWritable(windowId)
				this.assertOwner(windowId, action.tabId)
				this.assertUnreserved(action.tabId)
				this.commit(
					closeWorkspaceTab(this.layout, {
						windowId,
						groupId: action.groupId,
						tabId: action.tabId,
					}),
				)
				break
			case 'move':
				if (
					action.sourceWindowId &&
					action.sourceWindowId !== windowId &&
					action.targetWindowId !== windowId
				)
					throw new Error('This window cannot move that conversation.')
				this.assertOwner(action.sourceWindowId ?? windowId, action.tabId)
				this.assertUnreserved(action.tabId)
				if (
					[...this.transfers.values()].some(
						(item) => item.destinationWindowId === action.targetWindowId,
					)
				)
					throw new Error('This window is still opening.')
				if ((action.sourceWindowId ?? windowId) !== action.targetWindowId) {
					this.beginMove({
						...action,
						sourceWindowId: action.sourceWindowId ?? windowId,
						newGroupId: this.id(),
						newSplitId: this.id(),
						targetSize,
					})
				} else
					this.commit(
						moveWorkspaceTab(this.layout, {
							...action,
							sourceWindowId: windowId,
							newGroupId: this.id(),
							newSplitId: this.id(),
							targetSize,
						}),
					)
				break
			case 'resize':
				this.assertWindowWritable(windowId)
				this.commit(
					resizeWorkspaceSplit(this.layout, {
						windowId,
						splitId: action.splitId,
						ratio: action.ratio,
					}),
				)
				break
			default:
				throw new Error('Invalid workspace action.')
		}
		return this.layout.windows.some((item) => item.id === windowId)
			? this.view(windowId)
			: {
					windowId,
					sequence: this.sequence,
					homeGroupId: `home-${windowId}`,
					layout: this.snapshot(),
				}
	}
	beginDetach(
		windowId: string,
		tabId: string,
		sourceGroupId: string,
		bounds?: WorkspaceWindowBounds,
	): Transfer {
		this.assertOwner(windowId, tabId)
		this.assertUnreserved(tabId)
		if (locateWorkspaceTab(this.layout, tabId)?.groupId !== sourceGroupId)
			throw new Error('This workspace changed. Try the action again.')
		this.assertTransferWindows(windowId)
		const destinationWindowId = this.id()
		const groupId = `home-${destinationWindowId}`
		const transfer: Transfer = {
			id: this.id(),
			tabId,
			sourceWindowId: windowId,
			sourceGroupId,
			destinationWindowId,
			groupId,
			nativeWindow: true,
			sourceReady: true,
			destinationReady: false,
			move: {
				tabId,
				sourceWindowId: windowId,
				sourceGroupId,
				targetWindowId: destinationWindowId,
				targetGroupId: groupId,
				position: 'center',
			},
		}
		this.transfers.set(transfer.id, transfer)
		try {
			this.commit(addWorkspaceWindow(this.layout, { id: transfer.destinationWindowId, bounds }))
		} catch (error) {
			this.transfers.delete(transfer.id)
			throw error
		}
		return { ...transfer }
	}
	private assertTransferWindows(...windowIds: string[]): void {
		this.assertNotClosing(...windowIds)
		if (
			[...this.transfers.values()].some(
				(item) =>
					windowIds.includes(item.sourceWindowId) || windowIds.includes(item.destinationWindowId),
			)
		)
			throw new Error('Finish moving the conversation before moving another tab.')
	}
	private beginMove(move: WorkspaceMoveTab): void {
		this.assertTransferWindows(move.sourceWindowId, move.targetWindowId)
		if (!moveWorkspaceTab(this.layout, move))
			throw new Error('This workspace changed. Try the action again.')
		const transfer: Transfer = {
			id: this.id(),
			tabId: move.tabId,
			sourceWindowId: move.sourceWindowId,
			sourceGroupId: move.sourceGroupId,
			destinationWindowId: move.targetWindowId,
			groupId: move.targetGroupId,
			move,
			nativeWindow: false,
			sourceReady: false,
			destinationReady: false,
		}
		this.transfers.set(transfer.id, transfer)
		this.publish()
	}
	private transferLayout(transfer: Transfer): WorkspaceLayoutSnapshot | null {
		return moveWorkspaceTab(this.layout, transfer.move)
	}
	ready(windowId: string, transferId: unknown): WorkspaceView {
		if (typeof transferId !== 'string') throw new Error('Invalid workspace transfer.')
		const transfer = this.transfers.get(transferId)
		if (
			!transfer ||
			(transfer.destinationWindowId !== windowId && transfer.sourceWindowId !== windowId)
		)
			throw new Error('This window cannot acknowledge that conversation.')
		if (locateWorkspaceTab(this.layout, transfer.tabId)?.windowId !== transfer.sourceWindowId)
			throw new Error('This conversation moved to another window.')
		if (windowId === transfer.sourceWindowId) transfer.sourceReady = true
		else {
			if (!transfer.sourceReady)
				throw new Error('The source conversation is still preparing to move.')
			transfer.destinationReady = true
		}
		if (!transfer.sourceReady || !transfer.destinationReady) {
			this.publish()
			return this.view(windowId)
		}
		const next = this.transferLayout(transfer)
		if (!next) throw new Error('This workspace changed. Try the action again.')
		this.transfers.delete(transferId)
		try {
			this.commit(next)
		} catch (error) {
			this.transfers.set(transferId, transfer)
			throw error
		}
		return this.view(windowId)
	}
	rollback(transferId: string): void {
		const transfer = this.transfers.get(transferId)
		if (!transfer) return
		this.transfers.delete(transferId)
		try {
			if (transfer.nativeWindow)
				this.commit(removeWorkspaceWindow(this.layout, transfer.destinationWindowId))
			else this.publish()
		} catch (error) {
			this.transfers.set(transferId, transfer)
			throw error
		}
	}
	/** Closing a view redocks its tabs; it does not cancel its runtime or queued work. */
	closeWindow(windowId: string, targetWindowId?: string): void {
		const closingRequest = this.closing.get(windowId)
		this.abortTransfers(windowId)
		const closing = this.layout.windows.find((item) => item.id === windowId)
		if (!closing) return
		const target = this.layout.windows.find((item) => item.id === targetWindowId)
		if (!target) {
			this.closing.delete(windowId)
			return
		} // The final native window is retained for session restoration on quit.
		let next = this.layout
		for (const group of workspaceGroups(closing.root))
			for (const tabId of group.tabs) {
				const source = locateWorkspaceTab(next, tabId)
				if (!source) continue
				next = closeWorkspaceTab(next, { windowId, groupId: source.groupId, tabId }) ?? next
				next =
					openWorkspaceTab(next, { windowId: target.id, tabId, newGroupId: `home-${target.id}` }) ??
					next
			}
		this.closing.delete(windowId)
		try {
			this.commit(removeWorkspaceWindow(next, windowId))
		} catch (error) {
			if (closingRequest) this.closing.set(windowId, closingRequest)
			throw error
		}
	}
	setBounds(windowId: string, bounds: WorkspaceWindowBounds): void {
		const window = this.layout.windows.find((item) => item.id === windowId)
		if (!window || JSON.stringify(window.bounds) === JSON.stringify(bounds)) return
		const next = parseWorkspaceLayout({
			...this.layout,
			revision: this.layout.revision + 1,
			windows: this.layout.windows.map((item) =>
				item.id === windowId ? { ...item, bounds } : item,
			),
		})
		this.commit(next)
	}
}

/** Structural identity checks also make the privileged frame policy testable without Electron. */
export class WorkspaceWindowRegistry<
	T extends {
		isDestroyed(): boolean
		webContents: {
			mainFrame: unknown
			isDestroyed(): boolean
			send(channel: string, event: unknown): void
		}
	},
> {
	private readonly windows = new Map<string, T>()
	register(id: string, window: T): void {
		if (this.windows.has(id)) throw new Error('This window is already registered.')
		this.windows.set(id, window)
	}
	remove(id: string): void {
		this.windows.delete(id)
	}
	entries(): [string, T][] {
		return [...this.windows.entries()]
	}
	authenticate(
		event: { sender: unknown; senderFrame: { url: string } | null },
		page: string,
	): { id: string; window: T } {
		const entry = this.entries().find(
			([, window]) =>
				!window.isDestroyed() &&
				!window.webContents.isDestroyed() &&
				event.sender === window.webContents &&
				event.senderFrame === window.webContents.mainFrame &&
				event.senderFrame?.url === page,
		)
		if (!entry) throw new Error('This window cannot control Namzu.')
		return { id: entry[0], window: entry[1] }
	}
	fanout(event: unknown): void {
		for (const [, window] of this.windows)
			if (!window.isDestroyed() && !window.webContents.isDestroyed())
				window.webContents.send('namzu:event', event)
	}
}

export function clampWorkspaceBounds(
	bounds: WorkspaceWindowBounds | undefined,
	workAreas: readonly WorkspaceWindowBounds[],
): WorkspaceWindowBounds {
	const fallback = workAreas[0] ?? { x: 0, y: 0, width: 1180, height: 820 }
	const requested =
		bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
			? bounds
			: { x: fallback.x + 40, y: fallback.y + 40, width: 1180, height: 820 }
	const area =
		workAreas.find(
			(item) =>
				requested.x < item.x + item.width &&
				requested.x + requested.width > item.x &&
				requested.y < item.y + item.height &&
				requested.y + requested.height > item.y,
		) ?? fallback
	const width = Math.max(1, Math.min(Math.max(560, Math.round(requested.width)), area.width))
	const height = Math.max(1, Math.min(Math.max(460, Math.round(requested.height)), area.height))
	return {
		width,
		height,
		x: Math.round(Math.max(area.x, Math.min(requested.x, area.x + area.width - width))),
		y: Math.round(Math.max(area.y, Math.min(requested.y, area.y + area.height - height))),
	}
}
