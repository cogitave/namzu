import type { Message } from '../../types/message/index.js'
import { findSafeTrimIndex } from '../dangling.js'
import type { ConversationManager } from '../interface.js'

export interface SlidingWindowManagerConfig {
	/**
	 * Number of most recent messages to always keep.
	 * Default: 4
	 */
	keepRecentMessages?: number
}

/**
 * Simple window-based conversation manager.
 * Trims old messages to maintain a fixed-size window of recent context.
 * Fastest strategy, least context preservation.
 *
 * Algorithm:
 * 1. If message count exceeds window size, trim excess from the start
 * 2. Use findSafeTrimIndex to ensure tool call/result pairs remain atomic
 * 3. applyManagement runs proactively each iteration; reduceContext on overflow
 */
export class SlidingWindowManager implements ConversationManager {
	readonly name = 'sliding-window'
	private readonly keepRecentMessages: number

	constructor(config: SlidingWindowManagerConfig = {}) {
		this.keepRecentMessages = config.keepRecentMessages ?? 4
	}

	applyManagement(messages: Message[]): Message[] {
		// Trim to window size if needed
		if (messages.length <= this.keepRecentMessages) {
			return messages
		}

		const desiredTrimPoint = messages.length - this.keepRecentMessages
		const safeTrimIdx = findSafeTrimIndex(messages, desiredTrimPoint)
		return messages.slice(safeTrimIdx)
	}

	reduceContext(messages: Message[], _overflowTokens: number): boolean {
		// Try to reduce by trimming more aggressively
		// Target: keep even fewer messages than normal window
		const targetWindow = Math.max(1, Math.floor(this.keepRecentMessages * 0.5))
		const desiredTrimPoint = messages.length - targetWindow
		const safeTrimIdx = findSafeTrimIndex(messages, desiredTrimPoint)

		if (safeTrimIdx >= messages.length) {
			// Cannot trim further
			return false
		}

		// Successfully trimmed if we removed at least one message
		return safeTrimIdx > 0
	}
}
