import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type {
	LocalListeningEvent,
	LocalListeningState,
} from '../shared/local-listening-protocol.js'
import { plainErrorText } from './plain-error.js'

export interface LocalListeningRendererApi {
	localListeningState?(): Promise<LocalListeningState>
	localListeningInstall?(): Promise<LocalListeningState>
	localListeningCancelInstall?(): Promise<LocalListeningState>
	localListeningUninstall?(): Promise<LocalListeningState>
	onLocalListeningEvent?(listener: (event: LocalListeningEvent) => void): () => void
}

export interface LocalListeningSnapshot {
	state: LocalListeningState | null
	loading: boolean
	/** A remove or other short action is running. A download is `state.installation`, not this. */
	busy: boolean
	supported: boolean
	error?: string
}

function message(error: unknown): string {
	return error instanceof Error
		? plainErrorText(error, 'use voice input')
		: 'Voice input is unavailable.'
}

/** The downloaded voice-input engine as the window sees it: one snapshot, kept in step by events. */
export class LocalListeningController {
	private snapshot: LocalListeningSnapshot
	private listeners = new Set<() => void>()
	private unsubscribe: (() => void) | undefined
	private connected = false
	private lifetime = 0
	private stateRevision = 0

	constructor(private readonly api: LocalListeningRendererApi) {
		this.snapshot = {
			state: null,
			loading: true,
			busy: false,
			supported: !!(
				api.localListeningState &&
				api.localListeningInstall &&
				api.localListeningCancelInstall &&
				api.localListeningUninstall &&
				api.onLocalListeningEvent
			),
		}
	}

	getSnapshot = (): LocalListeningSnapshot => this.snapshot
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	connect(): () => void {
		this.connected = true
		this.lifetime += 1
		const lifetime = this.lifetime
		this.unsubscribe = this.api.onLocalListeningEvent?.((event) => {
			if (!this.connected || this.lifetime !== lifetime) return
			this.stateRevision += 1
			this.update({ state: event.state, loading: false })
		})
		void this.refresh(lifetime)
		return () => {
			if (this.lifetime !== lifetime) return
			this.connected = false
			this.lifetime += 1
			this.unsubscribe?.()
			this.unsubscribe = undefined
		}
	}

	private async refresh(lifetime: number): Promise<void> {
		if (!this.snapshot.supported) {
			this.update({ loading: false })
			return
		}
		const revision = this.stateRevision
		try {
			const state = await this.api.localListeningState?.()
			if (this.connected && this.lifetime === lifetime && this.stateRevision === revision && state)
				this.update({ state, loading: false })
			else if (this.connected && this.lifetime === lifetime) this.update({ loading: false })
		} catch (error) {
			if (this.connected && this.lifetime === lifetime)
				this.update({ loading: false, error: message(error) })
		}
	}

	install = (): Promise<void> => this.run(() => this.api.localListeningInstall?.(), false)
	uninstall = (): Promise<void> => this.run(() => this.api.localListeningUninstall?.(), true)
	/** Stops a download in progress and deletes what it had written. */
	cancelInstall = (): Promise<void> =>
		this.run(() => this.api.localListeningCancelInstall?.(), false)

	private async run(
		operation: () => Promise<LocalListeningState> | undefined,
		exclusive: boolean,
	): Promise<void> {
		if (!this.connected || !this.snapshot.supported || (exclusive && this.snapshot.busy)) return
		const lifetime = this.lifetime
		if (exclusive) this.update({ busy: true, error: undefined })
		else this.update({ error: undefined })
		try {
			const state = await operation()
			if (this.connected && this.lifetime === lifetime) {
				this.stateRevision += 1
				this.update({ ...(state ? { state } : {}), busy: false })
			}
		} catch (error) {
			if (this.connected && this.lifetime === lifetime)
				this.update({ busy: false, error: message(error) })
		}
	}

	private update(patch: Partial<LocalListeningSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...patch }
		for (const listener of this.listeners) listener()
	}
}

export interface LocalListeningControls extends LocalListeningSnapshot {
	install(): Promise<void>
	cancelInstall(): Promise<void>
	uninstall(): Promise<void>
}

export function useLocalListening(api: LocalListeningRendererApi): LocalListeningControls {
	const controller = useMemo(() => new LocalListeningController(api), [api])
	const snapshot = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getSnapshot,
	)
	useEffect(() => controller.connect(), [controller])
	return {
		...snapshot,
		install: controller.install,
		cancelInstall: controller.cancelInstall,
		uninstall: controller.uninstall,
	}
}
