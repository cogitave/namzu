import { useSyncExternalStore } from 'react'
import type { EngineUpdateId } from '../shared/engine-update-protocol.js'

/**
 * The engines that told this window no account is signed in. The only source is an engine's own
 * answer when it was started (its error says it needs an account), so a program that was never
 * started, or that cannot be asked, is never called signed out. Namzu does not run an engine's
 * login commands to find out: an unknown command could start a chat and spend the person's tokens.
 */
let current: ReadonlySet<EngineUpdateId> = new Set()
const listeners = new Set<() => void>()

/** Records that an engine reported no signed-in account, or that it no longer does. */
export function setEngineSignedOut(engine: EngineUpdateId, signedOut: boolean): void {
	if (current.has(engine) === signedOut) return
	const next = new Set(current)
	if (signedOut) next.add(engine)
	else next.delete(engine)
	current = next
	for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

export function useSignedOutEngines(): ReadonlySet<EngineUpdateId> {
	return useSyncExternalStore(
		subscribe,
		() => current,
		() => current,
	)
}

/** For tests: forget everything. */
export function resetSignedOutEngines(): void {
	current = new Set()
	for (const listener of listeners) listener()
}
