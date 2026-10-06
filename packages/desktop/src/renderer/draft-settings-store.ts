import type { DraftSettings } from '../shared/protocol.js'

export interface DraftSettingsSnapshot {
	readonly value?: DraftSettings
	readonly loading: boolean
	readonly error?: string
}

type OwnerState = {
	value?: DraftSettings
	known: boolean
	revision: number
	readEpoch: number
	reading?: Promise<void>
	refreshing?: { promise: Promise<void> }
	write?: Promise<void>
	unconfirmed?: DraftSettings
	error?: string
}

/** Keeps a failed read distinct from an empty, successfully read draft. */
export class DraftSettingsStore {
	private readonly owners = new Map<string, OwnerState>()
	constructor(
		private readonly read: (owner: string) => Promise<DraftSettings>,
		private readonly write: (owner: string, value: DraftSettings) => Promise<void>,
		private readonly changed: (owner: string, snapshot: DraftSettingsSnapshot) => void,
		private readonly failed: (owner: string, error: unknown) => void,
	) {}
	private state(owner: string): OwnerState {
		let state = this.owners.get(owner)
		if (!state) {
			state = { known: false, revision: 0, readEpoch: 0 }
			this.owners.set(owner, state)
		}
		return state
	}
	snapshot(owner: string): DraftSettingsSnapshot {
		const state = this.state(owner)
		return { value: state.value, loading: !state.known, error: state.error }
	}
	get(owner: string): DraftSettings {
		return this.state(owner).value ?? {}
	}
	private publish(owner: string): void {
		this.changed(owner, this.snapshot(owner))
	}
	cancelRead(owner: string): void {
		const state = this.state(owner)
		state.refreshing = undefined
		this.retireRead(state)
	}
	private retireRead(state: OwnerState): void {
		state.readEpoch++
		state.reading = undefined
	}
	load(owner: string): Promise<void> {
		const state = this.state(owner)
		if (state.known || state.unconfirmed) return Promise.resolve()
		if (state.reading) return state.reading
		const revision = state.revision
		const epoch = ++state.readEpoch
		state.error = undefined
		this.publish(owner)
		const current = () => state.readEpoch === epoch && state.revision === revision
		const pending = Promise.resolve()
			.then(() => this.read(owner))
			.then(
				(value) => {
					if (!current()) return
					state.value = value
					state.known = true
					state.error = undefined
					state.reading = undefined
					this.publish(owner)
				},
				(error) => {
					if (!current()) return
					state.error = 'Saved message settings could not be loaded. Try again.'
					state.reading = undefined
					this.publish(owner)
					this.failed(owner, error)
				},
			)
		state.reading = pending
		return pending
	}
	/** Reacquiring a pane reloads main's choices, preserving any unconfirmed local write. */
	reload(owner: string): Promise<void> {
		const state = this.state(owner)
		if (state.refreshing) return state.refreshing.promise
		const refresh = { promise: Promise.resolve() }
		state.refreshing = refresh
		const assertCurrent = () => {
			if (state.refreshing !== refresh)
				throw new Error('This conversation’s message settings changed while loading. Try again.')
		}
		refresh.promise = Promise.resolve()
			.then(async () => {
				assertCurrent()
				let write = state.write
				while (write) {
					try {
						await write
					} catch (error) {
						assertCurrent()
						if (state.write === write) throw error
					}
					assertCurrent()
					if (state.write === write) break
					write = state.write
				}
				if (state.unconfirmed)
					throw new Error(state.error ?? 'Message settings could not be saved. Try again.')
				this.retireRead(state)
				state.known = false
				await this.load(owner)
				assertCurrent()
				if (!state.known || state.error)
					throw new Error(state.error ?? 'Saved message settings could not be loaded. Try again.')
			})
			.finally(() => {
				if (state.refreshing === refresh) state.refreshing = undefined
			})
		return refresh.promise
	}
	save(owner: string, value: DraftSettings): Promise<void> {
		const state = this.state(owner)
		const snapshot = structuredClone(value)
		const revision = ++state.revision
		this.cancelRead(owner)
		state.value = snapshot
		state.unconfirmed = snapshot
		state.error = undefined
		this.publish(owner)
		// Serialize each owner's writes so a slower earlier choice cannot replace a later one.
		const pending = (state.write ?? Promise.resolve())
			.catch(() => {})
			.then(() => this.write(owner, snapshot))
			.then(
				() => {
					if (state.revision !== revision) return
					state.known = true
					state.unconfirmed = undefined
					state.error = undefined
					this.publish(owner)
				},
				(error) => {
					if (state.revision === revision) {
						state.error = 'Message settings could not be saved. Try again.'
						this.publish(owner)
					}
					throw error
				},
			)
		state.write = pending
		return pending
	}
	retry(owner: string): Promise<void> {
		const state = this.state(owner)
		// Retry a failed write with the user's actual choice, without replacing it
		// with older settings from main.
		if (state.unconfirmed) return this.save(owner, state.unconfirmed)
		this.cancelRead(owner)
		return this.load(owner)
	}
}
