import type {
	PalCommunicationView,
	PalPermissionChange,
	PalSubscriptionCreate,
	PalSubscriptionDisable,
} from '../shared/pal-communication-protocol.js'
import type { DesktopApi } from '../shared/protocol.js'

export interface PalCommunicationState {
	view?: PalCommunicationView
	loading: boolean
	busy: boolean
	error?: string
	needsRefresh: boolean
}
/** A dialog lifetime owns its reads; replies cannot update a closed or replaced view. */
export class PalCommunicationController {
	private state: PalCommunicationState = { loading: false, busy: false, needsRefresh: false }
	private generation = 0
	private disposed = false
	private listeners = new Set<() => void>()
	constructor(
		private readonly api: DesktopApi,
		private readonly sessionId: string,
		private readonly palId: string,
	) {}
	getSnapshot = () => this.state
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private set(next: PalCommunicationState) {
		this.state = next
		for (const listener of this.listeners) listener()
	}
	private accepts(generation: number) {
		return !this.disposed && this.generation === generation
	}
	async load(): Promise<void> {
		if (this.disposed || this.state.busy) return
		const generation = ++this.generation
		this.set({ ...this.state, loading: true, error: undefined })
		try {
			if (!this.api.palCommunication)
				throw new Error('Update the desktop app to manage Pal communication.')
			const view = await this.api.palCommunication(this.sessionId, this.palId)
			if (!this.accepts(generation)) return
			if (view.palId !== this.palId)
				throw new Error('This Pal view changed. Open Communication again.')
			this.set({ view, loading: false, busy: false, needsRefresh: false })
		} catch {
			if (this.accepts(generation))
				this.set({
					...this.state,
					loading: false,
					needsRefresh: true,
					error:
						'Communication is unavailable. Previously loaded entries are retained. Refresh to try again.',
				})
		}
	}
	private async change(
		operation: (snapshotId: string) => Promise<PalCommunicationView>,
	): Promise<void> {
		if (
			this.disposed ||
			this.state.busy ||
			this.state.loading ||
			this.state.needsRefresh ||
			!this.state.view?.supported
		)
			return
		const snapshotId = this.state.view.snapshotId
		const generation = ++this.generation
		this.set({ ...this.state, busy: true, error: undefined })
		try {
			const view = await operation(snapshotId)
			if (!this.accepts(generation)) return
			if (view.palId !== this.palId) throw new Error('Foreign Pal view.')
			this.set({ view, loading: false, busy: false, needsRefresh: false })
		} catch {
			if (this.accepts(generation))
				this.set({
					...this.state,
					busy: false,
					needsRefresh: true,
					error:
						'The change could not be confirmed. Refresh to check current permissions before trying again.',
				})
		}
	}
	permission(change: Omit<PalPermissionChange, 'snapshotId'>): Promise<void> {
		return this.change(async (snapshotId) => {
			if (!this.api.updatePalPermission) throw new Error('Unavailable.')
			return this.api.updatePalPermission(this.sessionId, this.palId, { ...change, snapshotId })
		})
	}
	create(input: Omit<PalSubscriptionCreate, 'snapshotId'>): Promise<void> {
		return this.change(async (snapshotId) => {
			if (!this.api.createPalSubscription) throw new Error('Unavailable.')
			return this.api.createPalSubscription(this.sessionId, this.palId, { ...input, snapshotId })
		})
	}
	disable(subscriptionId: PalSubscriptionDisable['subscriptionId']): Promise<void> {
		return this.change(async (snapshotId) => {
			if (!this.api.disablePalSubscription) throw new Error('Unavailable.')
			return this.api.disablePalSubscription(this.sessionId, this.palId, {
				subscriptionId,
				snapshotId,
			})
		})
	}
	dispose() {
		this.disposed = true
		this.generation++
		this.listeners.clear()
	}
	/** React's development effect replay starts a fresh read lifetime on the same controller. */
	activate() {
		if (!this.disposed) return
		this.disposed = false
		this.generation++
		this.state = { ...this.state, loading: false, busy: false }
	}
}
