/**
 * Two things every reader of a memory needs besides its body: which other
 * memories it points at, and how old it is.
 */

import { MEMORY_NAME_MAX_LENGTH } from './naming.js'

const LINK = /\[\[([a-z0-9]+(?:-[a-z0-9]+)*)\]\]/g
const MAX_LINKS = 20
const DAY_MS = 86_400_000

/** The distinct `[[name]]` targets in `content`, in order of first mention, at most 20. */
export function memoryLinkNames(content: string): string[] {
	const names: string[] = []
	for (const match of content.matchAll(LINK)) {
		const name = match[1]
		if (!name || name.length > MEMORY_NAME_MAX_LENGTH || names.includes(name)) continue
		names.push(name)
		if (names.length >= MAX_LINKS) break
	}
	return names
}

/**
 * `today`, `1 day old`, `12 days old`. Whole days, because a memory is a
 * point-in-time claim and the question a reader has is whether the world has
 * had time to move since — which hours do not answer and days do.
 */
export function describeMemoryAge(updatedAt: number, now: number = Date.now()): string {
	const days = Math.max(0, Math.floor((now - updatedAt) / DAY_MS))
	if (days === 0) return 'today'
	return `${days} day${days === 1 ? '' : 's'} old`
}

/** The sentence every aged memory carries, so the model checks before it relies. */
export const MEMORY_VERIFY_NOTICE =
	'Memories are point-in-time: a file, function, flag or command a memory names may have changed or gone since. Verify it against the current code before relying on it, and update or archive the memory if it is wrong.'
