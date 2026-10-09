import type { ThreadState } from '../shared/projection.js'
import { palMessageSends } from './pal-message-receipts.js'

/**
 * Pals that have a message from the person they have not opened yet. Only sends made while this
 * window was running count, so replaying an old conversation never lights a marker.
 */
export function unreadAfterSends(
	previous: ReadonlySet<string>,
	counted: Set<string>,
	threads: Readonly<Record<string, ThreadState>>,
	pals: readonly { id: string; name: string }[],
	openPalId: string | undefined,
): ReadonlySet<string> {
	let next: Set<string> | undefined
	for (const [sessionId, thread] of Object.entries(threads)) {
		for (const send of palMessageSends(thread.timeline, thread)) {
			const key = `${sessionId}:${send.id}`
			if (counted.has(key)) continue
			counted.add(key)
			const matches = pals.filter((pal) => pal.name === send.name)
			const target = matches.length === 1 ? matches[0] : undefined
			if (!target || target.id === openPalId) continue
			next ??= new Set(previous)
			next.add(target.id)
		}
	}
	return next ?? previous
}

/**
 * The Pals that a message was sent to since this was last called, once per send, so each can be
 * asked whether it is running. `seen` is the caller's own memory of sends already handled.
 */
export function newPalSendTargets(
	seen: Set<string>,
	threads: Readonly<Record<string, ThreadState>>,
	pals: readonly { id: string; name: string }[],
): string[] {
	const targets = new Set<string>()
	for (const [sessionId, thread] of Object.entries(threads)) {
		for (const send of palMessageSends(thread.timeline, thread)) {
			const key = `${sessionId}:${send.id}`
			if (seen.has(key)) continue
			seen.add(key)
			const matches = pals.filter((pal) => pal.name === send.name)
			if (matches.length === 1 && matches[0]) targets.add(matches[0].id)
		}
	}
	return [...targets]
}

/** Opening a Pal reads its messages. */
export function unreadAfterOpen(previous: ReadonlySet<string>, palId: string): ReadonlySet<string> {
	if (!previous.has(palId)) return previous
	const next = new Set(previous)
	next.delete(palId)
	return next
}
