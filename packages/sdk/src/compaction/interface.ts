import type { Message } from '../types/message/index.js'

/**
 * Strategy interface for managing conversation context.
 * Implementations decide how to handle context overflow and message trimming.
 *
 * A manager applies two strategies:
 * 1. **Routine management** (applyManagement): Called after each iteration to proactively optimize context.
 * 2. **Overflow reduction** (reduceContext): Called when the LLM reports context window exceeded.
 *
 * @deprecated Use {@link ContextReducer}, which the runtime actually drives.
 *
 * This interface cannot be implemented correctly. `reduceContext` is
 * documented as reducing the history, but it takes `Message[]` and returns
 * `boolean` — the only way to honour the contract is to mutate the argument
 * in place, and neither shipped implementation does. Both build a shorter
 * array locally, discard it, and return `true`. Nothing in the runtime ever
 * called any of it, which is why an unfulfillable contract survived.
 *
 * `ContextReducer` returns the new history, may be async so a reducer can
 * call a model, and is told whether it was asked speculatively or after the
 * provider rejected the prompt. Kept exported until the next major.
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
