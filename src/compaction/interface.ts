import type { Message } from '../types/message/index.js'

/**
 * Strategy interface for managing conversation context.
 * Implementations decide how to handle context overflow and message trimming.
 *
 * A manager applies two strategies:
 * 1. **Routine management** (applyManagement): Called after each iteration to proactively optimize context.
 * 2. **Overflow reduction** (reduceContext): Called when the LLM reports context window exceeded.
 */
export interface ConversationManager {
	/** Unique name for this manager (e.g., 'structured', 'sliding-window', 'disabled') */
	readonly name: string

	/**
	 * Apply routine management after each iteration.
	 * Called proactively, not in response to an error.
	 * Returns modified messages array (or same reference if no changes).
	 *
	 * @param messages - Current message history
	 * @returns Modified messages array (may be same reference if no changes made)
	 */
	applyManagement(messages: Message[]): Message[]

	/**
	 * Reduce context when overflow is detected.
	 * Called when the LLM reports context window exceeded.
	 * Returns true if context was successfully reduced, false if no reduction possible.
	 *
	 * @param messages - Current message history
	 * @param overflowTokens - Approximate number of tokens over budget
	 * @returns true if context was successfully reduced, false if no reduction possible
	 */
	reduceContext(messages: Message[], overflowTokens: number): boolean
}
