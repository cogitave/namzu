/**
 * The window's saved interface state, as the renderer sees it.
 *
 * Main keeps it in one file (see `main/state-store`); the page reads a snapshot before its first
 * paint and writes through to main. The object is shaped like `Storage`, so every reader that took
 * `localStorage` takes this unchanged, and a change made in another window arrives as the same
 * `storage` event those readers already listen for.
 *
 * This is the only module in the renderer that may touch `localStorage`: it does so once, to hand
 * over what an older version kept there, then deletes it.
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { ViewStateBridge } from '../shared/protocol.js'
import { defineOf } from '../shared/state-registry.js'

type Listener = () => void

export interface ViewStateOptions {
	/** Main's side of the store. Absent in a test or a plain browser: state then lives in memory. */
	readonly bridge?: ViewStateBridge | undefined
	/** What an older version kept; handed over once, then emptied of the keys main took. */
	readonly legacy?: Pick<Storage, 'getItem' | 'removeItem' | 'key' | 'length'> | undefined
	/** Tells the page another window changed a key. Defaults to a real `storage` event. */
	readonly announce?: (key: string, newValue: string | null, oldValue: string | null) => void
}

const LEGACY_PREFIX = 'namzu.'

function legacyEntries(legacy: NonNullable<ViewStateOptions['legacy']>): Record<string, string> {
	const found: Record<string, string> = {}
	try {
		for (let index = 0; index < legacy.length; index++) {
			const key = legacy.key(index)
			if (!key?.startsWith(LEGACY_PREFIX) || !defineOf(key)) continue
			const value = legacy.getItem(key)
			if (typeof value === 'string') found[key] = value
		}
	} catch {
		// Storage that cannot be read has nothing to hand over.
	}
	return found
}

export class ViewStateStorage {
	private readonly cache = new Map<string, string>()
	private readonly listeners = new Set<Listener>()

	constructor(private readonly options: ViewStateOptions = {}) {
		const { bridge, legacy } = options
		for (const [key, value] of Object.entries(bridge?.snapshot ?? {})) this.cache.set(key, value)
		if (bridge && legacy) {
			const entries = legacyEntries(legacy)
			if (Object.keys(entries).length > 0) {
				const answer = bridge.importLegacy(entries)
				if (answer) {
					this.cache.clear()
					for (const [key, value] of Object.entries(answer.snapshot)) this.cache.set(key, value)
					for (const key of answer.deletable) {
						try {
							legacy.removeItem(key)
						} catch {
							// A key that stays behind is imported again next time and found already stored.
						}
					}
				}
			}
		}
		bridge?.onChange(({ key, value }) => {
			const before = this.cache.get(key) ?? null
			if (value === null) this.cache.delete(key)
			else this.cache.set(key, value)
			this.notify()
			this.options.announce?.(key, value, before)
		})
	}

	get length(): number {
		return this.cache.size
	}
	key(index: number): string | null {
		return [...this.cache.keys()][index] ?? null
	}
	getItem(key: string): string | null {
		return this.cache.get(key) ?? null
	}
	setItem(key: string, value: string): void {
		const text = String(value)
		this.cache.set(key, text)
		const def = defineOf(key)
		// A key main does not declare, or a value over its cap, lasts for this window only.
		if (def && new TextEncoder().encode(text).length <= def.maxBytes)
			this.options.bridge?.set(key, text)
		this.notify()
	}
	removeItem(key: string): void {
		if (!this.cache.delete(key)) return
		this.options.bridge?.remove(key)
		this.notify()
	}
	clear(): void {
		for (const key of [...this.cache.keys()]) this.removeItem(key)
	}

	/** Calls `listener` after any change, local or from another window. Returns the way to stop. */
	subscribe(listener: Listener): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	private notify(): void {
		for (const listener of this.listeners) listener()
	}
}

function pageStorage(): ViewStateOptions['legacy'] {
	try {
		return typeof localStorage === 'undefined' ? undefined : localStorage
	} catch {
		return undefined
	}
}

function announceToPage(key: string, newValue: string | null, oldValue: string | null): void {
	if (typeof window === 'undefined' || typeof StorageEvent === 'undefined') return
	window.dispatchEvent(new StorageEvent('storage', { key, newValue, oldValue }))
}

/** The window's interface state. Use this where code once used `localStorage`. */
export const viewState = new ViewStateStorage({
	bridge: typeof window === 'undefined' ? undefined : window.namzu?.viewState,
	legacy: pageStorage(),
	announce: announceToPage,
}) as ViewStateStorage & Storage

/** A saved value and a way to change it; re-renders on a change from anywhere, another window included. */
export function useStateKey(
	key: string,
	storage: ViewStateStorage = viewState,
): [string | null, (value: string | null) => void] {
	const value = useSyncExternalStore(
		(listener) => storage.subscribe(listener),
		() => storage.getItem(key),
		() => storage.getItem(key),
	)
	const set = useCallback(
		(next: string | null) => {
			if (next === null) storage.removeItem(key)
			else storage.setItem(key, next)
		},
		[key, storage],
	)
	return [value, set]
}
