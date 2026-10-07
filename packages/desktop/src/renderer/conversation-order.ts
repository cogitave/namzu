import type { ConversationView } from '../shared/protocol.js'

function updatedTime(view: ConversationView) {
	const time = Date.parse(view.updatedAt)
	return Number.isFinite(time) ? time : 0
}

/** Saved recency with a stable identity order when timestamps tie. */
export function compareConversationRecency(left: ConversationView, right: ConversationView) {
	const difference = updatedTime(right) - updatedTime(left)
	if (difference !== 0) return difference
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/** Pinned conversations lead; each side then keeps its recency order. */
export function compareConversationOrder(left: ConversationView, right: ConversationView) {
	const pinned = Number(right.pinned === true) - Number(left.pinned === true)
	return pinned !== 0 ? pinned : compareConversationRecency(left, right)
}
