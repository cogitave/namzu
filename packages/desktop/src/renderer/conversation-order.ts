import type { ConversationView } from '../shared/protocol.js'

function updatedTime(view: ConversationView) {
	const time = Date.parse(view.updatedAt)
	return Number.isFinite(time) ? time : 0
}

/**
 * Saved recency. Timestamps that tie keep a stable order that puts the newer conversation first:
 * ids are time-ordered, so the larger id is the later one. The older one winning a tie once made
 * "open the Pal" land on its first conversation instead of the one it had just written.
 */
export function compareConversationRecency(left: ConversationView, right: ConversationView) {
	const difference = updatedTime(right) - updatedTime(left)
	if (difference !== 0) return difference
	return left.id > right.id ? -1 : left.id < right.id ? 1 : 0
}

/** Pinned conversations lead; each side then keeps its recency order. */
export function compareConversationOrder(left: ConversationView, right: ConversationView) {
	const pinned = Number(right.pinned === true) - Number(left.pinned === true)
	return pinned !== 0 ? pinned : compareConversationRecency(left, right)
}
