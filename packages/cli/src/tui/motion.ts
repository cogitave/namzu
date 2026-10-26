/**
 * Whether decoration may move: the working line's sweep and the stall tint,
 * and the composer's pulse. Off when the person asked for reduced motion
 * (`tui.reducedMotion`, or `/config motion on`) and wherever colour itself is
 * refused (`NO_COLOR`, `FORCE_COLOR=0`, a dumb terminal).
 */

import { useSyncExternalStore } from 'react'

let reduced = false
const listeners = new Set<() => void>()

/** Set from the config at launch and from `/config motion`. */
export function setReducedMotion(value: boolean): void {
	if (reduced === value) return
	reduced = value
	for (const listener of [...listeners]) listener()
}

export function reducedMotion(): boolean {
	return reduced
}

/** Motion is allowed unless reduced or the terminal refuses colour. */
export function motionAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
	return !reduced && env.NO_COLOR === undefined && env.FORCE_COLOR !== '0' && env.TERM !== 'dumb'
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

/** Redraws the calling component when the setting changes. */
export function useReducedMotion(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => reduced,
		() => reduced,
	)
}
