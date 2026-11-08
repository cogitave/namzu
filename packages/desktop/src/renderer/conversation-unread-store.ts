import { useSyncExternalStore } from 'react'
import type { ConversationUnreadView, DesktopEvent } from '../shared/protocol.js'

export interface ConversationUnreadApi {
	conversationUnread?(): Promise<ConversationUnreadView>
	setConversationUnread?(id: string, unread: boolean): Promise<ConversationUnreadView>
	onEvent(listener: (event: DesktopEvent) => void): () => void
}

const NONE: ReadonlySet<string> = new Set()

/**
 * This window's copy of the unread conversations. Main owns the set and numbers every change; the
 * window keeps whichever answer carries the higher number. An invoke reply can land before an
 * event that main sent earlier (and so after a newer one), so arrival order decides nothing.
 */
export class ConversationUnreadStore {
	private ids: ReadonlySet<string> = NONE
	private sequence = -1
	private readonly listeners = new Set<() => void>()
	private started = false
	private stop: (() => void) | undefined

	constructor(private readonly api: ConversationUnreadApi) {}

	snapshot = (): ReadonlySet<string> => this.ids

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		this.start()
		return () => {
			this.listeners.delete(listener)
			if (this.listeners.size === 0) this.halt()
		}
	}

	/** Marks one conversation unread or read through main; every window follows its event. */
	set(id: string, unread: boolean): Promise<void> {
		const write = this.api.setConversationUnread
		if (!write) return Promise.resolve()
		return write.call(this.api, id, unread).then((view) => this.accept(view))
	}

	private start(): void {
		if (this.started) return
		this.started = true
		this.stop = this.api.onEvent((event) => {
			if (event.kind === 'unread') this.accept(event)
		})
		void this.api
			.conversationUnread?.()
			.then((view) => this.accept(view))
			.catch(() => undefined)
	}

	private halt(): void {
		this.stop?.()
		this.stop = undefined
		this.started = false
		this.sequence = -1
		this.ids = NONE
	}

	private accept(view: ConversationUnreadView): void {
		if (!this.started || view.sequence <= this.sequence) return
		this.sequence = view.sequence
		this.ids = new Set(view.ids)
		for (const listener of [...this.listeners]) listener()
	}
}

const stores = new WeakMap<object, ConversationUnreadStore>()
export function conversationUnreadStore(api: ConversationUnreadApi): ConversationUnreadStore {
	let store = stores.get(api)
	if (!store) {
		store = new ConversationUnreadStore(api)
		stores.set(api, store)
	}
	return store
}

/** The conversations with a finished turn nobody has looked at. Empty where there is no host. */
export function useConversationUnread(api: ConversationUnreadApi | undefined): {
	ids: ReadonlySet<string>
	set: (id: string, unread: boolean) => Promise<void>
} {
	const store = api ? conversationUnreadStore(api) : undefined
	const ids = useSyncExternalStore(
		store?.subscribe ?? noSubscribe,
		store?.snapshot ?? (() => NONE),
		() => NONE,
	)
	return { ids, set: store ? store.set.bind(store) : () => Promise.resolve() }
}
const noSubscribe = () => () => undefined
