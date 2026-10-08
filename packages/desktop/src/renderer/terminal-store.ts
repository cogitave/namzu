import { useSyncExternalStore } from 'react'
import type { DesktopEvent } from '../shared/protocol.js'
import type { TerminalTabView } from '../shared/terminal-tabs.js'

export interface TerminalTabsApi {
	terminals?(): Promise<TerminalTabView[]>
	onEvent(listener: (event: DesktopEvent) => void): () => void
}

const NONE: readonly TerminalTabView[] = []

/**
 * The window's copy of the terminal tab list. Main owns it and pushes the whole list whenever it
 * changes; the first read fills it, and a push that lands before that read answers wins.
 */
export class TerminalTabsStore {
	private tabs: readonly TerminalTabView[] = NONE
	private readonly listeners = new Set<() => void>()
	private started = false
	private pushed = false
	private stop: (() => void) | undefined

	constructor(private readonly api: TerminalTabsApi) {}

	snapshot = (): readonly TerminalTabView[] => this.tabs

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		this.start()
		return () => {
			this.listeners.delete(listener)
			if (this.listeners.size === 0) this.halt()
		}
	}

	private start(): void {
		if (this.started) return
		this.started = true
		this.stop = this.api.onEvent((event) => {
			if (event.kind !== 'terminals') return
			this.pushed = true
			this.set(event.terminals)
		})
		void this.api
			.terminals?.()
			.then((tabs) => {
				if (!this.pushed && this.started) this.set(tabs)
			})
			.catch(() => undefined)
	}

	private halt(): void {
		this.stop?.()
		this.stop = undefined
		this.started = false
		this.pushed = false
	}

	private set(tabs: readonly TerminalTabView[]): void {
		this.tabs = tabs
		for (const listener of [...this.listeners]) listener()
	}
}

const stores = new WeakMap<object, TerminalTabsStore>()
export function terminalTabsStore(api: TerminalTabsApi): TerminalTabsStore {
	let store = stores.get(api)
	if (!store) {
		store = new TerminalTabsStore(api)
		stores.set(api, store)
	}
	return store
}

/** The terminal tabs of the app, current. Empty where there is no host to run them. */
export function useTerminalTabs(api: TerminalTabsApi | undefined): readonly TerminalTabView[] {
	const store = api ? terminalTabsStore(api) : undefined
	return useSyncExternalStore(
		store?.subscribe ?? noSubscribe,
		store?.snapshot ?? (() => NONE),
		() => NONE,
	)
}
const noSubscribe = () => () => undefined
