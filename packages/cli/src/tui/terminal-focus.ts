/**
 * Whether the terminal window has focus, as the terminal reports it.
 *
 * Three states. `unknown` is the start, and stays so on a terminal that never
 * reports; it counts as focused, so only an explicit blur report ever makes
 * the interface behave as if the person is away. A key press while blurred
 * proves the person is there, so it flips back to focused (a lost focus-in
 * report heals itself on the next key).
 */

import { useSyncExternalStore } from 'react'

export type TerminalFocusState = 'unknown' | 'focused' | 'blurred'

export interface TerminalFocusStore {
	state(): TerminalFocusState
	/** `state() !== 'blurred'`. */
	isFocused(): boolean
	/** When focus last came back (a focus report or a key), `0` if it never did. */
	gainedAt(): number
	/** Apply a report. A blur while already blurred changes nothing. */
	set(focused: boolean): void
	/** A key or a paste arrived: if blurred, the person is evidently here. */
	noteInput(): void
	/** Called after every change. Returns the unsubscribe. */
	subscribe(listener: () => void): () => void
}

export function createTerminalFocus(now: () => number = Date.now): TerminalFocusStore {
	let state: TerminalFocusState = 'unknown'
	let gainedAt = 0
	const listeners = new Set<() => void>()
	const emit = (): void => {
		for (const listener of [...listeners]) listener()
	}
	const set = (focused: boolean): void => {
		if (focused) gainedAt = now()
		if (!focused && state === 'blurred') return
		state = focused ? 'focused' : 'blurred'
		emit()
	}
	return {
		state: () => state,
		isFocused: () => state !== 'blurred',
		gainedAt: () => gainedAt,
		set,
		noteInput: () => {
			if (state === 'blurred') set(true)
		},
		subscribe: (listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
	}
}

/** The one store for this process's terminal. */
export const terminalFocus: TerminalFocusStore = createTerminalFocus()

/** `false` only after an explicit blur report. */
export function useTerminalFocused(store: TerminalFocusStore = terminalFocus): boolean {
	return useSyncExternalStore(store.subscribe, store.isFocused, store.isFocused)
}
