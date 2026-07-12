import type { AssistantMessage, Message, ToolMessage } from '../types/message/index.js'

/**
 * Represents the result of scanning messages for dangling tool call/result pairs.
 * Used to identify which messages should be removed to ensure message validity.
 */
export interface DanglingResult {
	/** Indices of assistant messages with unmatched tool calls */
	assistantsWithUnmatchedCalls: number[]
	/** Indices of tool messages with no matching assistant tool call */
	orphanedToolMessages: number[]
	/** Whether the message sequence is valid (no dangling messages) */
	isValid: boolean
}

/**
 * Named constants for dangling message detection logic.
 */
const CONSTANTS = {
	/** Role sentinel for tool message identification */
	TOOL_ROLE: 'tool',
	/** Role sentinel for assistant message identification */
	ASSISTANT_ROLE: 'assistant',
} as const

/**
 * Checks if a message is an assistant message with tool calls.
 * @param message - Message to inspect
 * @returns true if message has role 'assistant' and contains toolCalls array
 */
function hasToolCalls(message: Message): boolean {
	return (
		message.role === CONSTANTS.ASSISTANT_ROLE &&
		'toolCalls' in message &&
		Array.isArray(message.toolCalls) &&
		message.toolCalls.length > 0
	)
}

/**
 * Checks if a message is a tool result message.
 * @param message - Message to inspect
 * @returns true if message has role 'tool'
 */
function isToolMessage(message: Message): boolean {
	return message.role === CONSTANTS.TOOL_ROLE
}

/**
 * Scans a message sequence and identifies dangling tool call/result pairs.
 *
 * A dangling pair occurs when:
 * 1. An assistant message has tool calls but no matching tool message follows
 * 2. A tool message exists but its toolCallId doesn't match any preceding assistant tool call
 *
 * @param messages - Array of messages to scan
 * @returns DanglingResult with indices of invalid messages
 *
 * @example
 * ```typescript
 * const messages = [
 *   { role: 'user', content: 'test' },
 *   { role: 'assistant', content: null, toolCalls: [{ id: '1', type: 'function', function: { name: 'test', arguments: '{}' } }] },
 *   // Missing tool message for call id '1'
 *   { role: 'user', content: 'next' }
 * ]
 * const result = findDanglingMessages(messages)
 * // result.assistantsWithUnmatchedCalls = [1] (index 1 has unmatched tool call)
 * ```
 */
export function findDanglingMessages(messages: Message[]): DanglingResult {
	const assistantsWithUnmatchedCalls: number[] = []
	const orphanedToolMessages: number[] = []

	// Build a set of all tool call IDs that exist in assistant messages
	// along with their coverage map (which tool messages satisfy them)
	const toolCallIds = new Map<string, { assistantIndex: number; satisfied: boolean }>()

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]
		if (!message) continue

		if (hasToolCalls(message)) {
			// Record all tool calls from this assistant message
			const assistantMsg = message as { toolCalls?: Array<{ id: string }> }
			if (assistantMsg.toolCalls) {
				for (const toolCall of assistantMsg.toolCalls) {
					toolCallIds.set(toolCall.id, { assistantIndex: i, satisfied: false })
				}
			}
		}
	}

	// Second pass: mark satisfied tool calls and find orphaned tool messages
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]
		if (!message) continue

		if (isToolMessage(message)) {
			const toolMsg = message as { toolCallId: string }
			if (toolCallIds.has(toolMsg.toolCallId)) {
				// Tool message satisfies a preceding tool call
				const entry = toolCallIds.get(toolMsg.toolCallId)
				if (entry) {
					entry.satisfied = true
				}
			} else {
				// Tool message has no matching tool call
				orphanedToolMessages.push(i)
			}
		}
	}

	// Third pass: identify unsatisfied tool calls
	for (const entry of toolCallIds.values()) {
		if (!entry.satisfied) {
			assistantsWithUnmatchedCalls.push(entry.assistantIndex)
		}
	}

	return {
		assistantsWithUnmatchedCalls,
		orphanedToolMessages,
		isValid: assistantsWithUnmatchedCalls.length === 0 && orphanedToolMessages.length === 0,
	}
}

/**
 * Removes dangling messages from a message sequence, preserving order.
 *
 * This function removes the minimum set of messages needed to ensure
 * all remaining tool call/result pairs are valid and complete.
 *
 * Algorithm:
 * 1. Identify dangling assistant messages and orphaned tool messages
 * 2. Remove orphaned tool messages
 * 3. For assistant messages with unmatched calls, remove both the assistant
 *    message AND any following tool messages that attempt to satisfy it
 *
 * @param messages - Array of messages to clean
 * @returns New array with dangling messages removed, original order preserved
 *
 * @example
 * ```typescript
 * const messages = [
 *   { role: 'user', content: 'test' },
 *   { role: 'assistant', content: null, toolCalls: [{ id: '1', ... }] },
 *   // Missing tool response
 *   { role: 'user', content: 'next' }
 * ]
 * const clean = removeDanglingMessages(messages)
 * // Result: [{ role: 'user', content: 'test' }, { role: 'user', content: 'next' }]
 * ```
 */
export function removeDanglingMessages(messages: Message[]): Message[] {
	const result = findDanglingMessages(messages)

	if (result.isValid) {
		return messages.slice() // Return shallow copy if already valid
	}

	// Build a set of indices to remove
	const indicesToRemove = new Set<number>()

	// Mark orphaned tool messages for removal
	for (const idx of result.orphanedToolMessages) {
		indicesToRemove.add(idx)
	}

	// For unsatisfied assistant messages:
	// 1. Remove the assistant message itself
	// 2. Remove any immediately following tool messages (they can't match)

	for (const assistantIdx of result.assistantsWithUnmatchedCalls) {
		indicesToRemove.add(assistantIdx)

		// Collect the tool call IDs from this unsatisfied assistant message
		const assistantMsg = messages[assistantIdx] as {
			toolCalls?: Array<{ id: string }>
		}
		const toolCallIds = new Set<string>()
		if (assistantMsg.toolCalls) {
			for (const toolCall of assistantMsg.toolCalls) {
				toolCallIds.add(toolCall.id)
			}
		}

		// Remove any following tool messages that match these tool call IDs
		// (they are orphaned now that the assistant message is removed)
		for (let i = assistantIdx + 1; i < messages.length; i++) {
			const msg = messages[i]
			if (!msg) continue
			if (isToolMessage(msg)) {
				const toolMsg = msg as { toolCallId: string }
				if (toolCallIds.has(toolMsg.toolCallId)) {
					indicesToRemove.add(i)
				}
			}
		}
	}

	// Return messages not marked for removal, preserving order
	return messages.filter((_, idx) => !indicesToRemove.has(idx))
}

/**
 * Fixed content for a tool result synthesized in place of one that never
 * arrived (the run was interrupted after the model requested the call but
 * before the tool completed). The wording is stable so downstream
 * summarisers and provider adapters can recognise a synthesized result.
 */
const MISSING_TOOL_RESULT_CONTENT =
	'[SYSTEM] Tool result missing: run was interrupted before this tool completed.'

/**
 * Repairs a message sequence into a provider-valid shape **without dropping
 * assistant tool calls**. Where {@link removeDanglingMessages} deletes the
 * offending assistant messages, this function *heals* the history so it can
 * be resumed or replayed. Three ordered steps:
 *
 * 1. **Drop orphaned tool messages.** A `tool` result whose `toolCallId`
 *    matches no assistant tool call anywhere in the sequence is removed —
 *    provider APIs reject such results and the information is unrecoverable.
 * 2. **Synthesize missing results.** Every assistant tool call with no
 *    matching `tool` result gets one error placeholder
 *    ({@link MISSING_TOOL_RESULT_CONTENT}). Its `timestamp` is *derived* from
 *    the assistant message (`assistant.timestamp + 1`), never wall-clock, so
 *    the function stays pure and deterministic.
 * 3. **Canonicalize placement and de-duplicate.** Every tool result is relocated
 *    to sit immediately after its assistant message, in the assistant's declared
 *    `toolCalls` order, and exactly ONE result survives per `toolCallId` (the
 *    first). This makes the output robust against callers that append results at
 *    the tail (e.g. replay mutations), against providers (Anthropic/Bedrock) that
 *    flush the pending tool block when a non-tool message intervenes, and against
 *    a history that recorded a result twice — which every provider rejects.
 *
 * Pure, deterministic, and idempotent: `repair(repair(x))` deep-equals
 * `repair(x)`. Returns a new array; never mutates the input array or its
 * message objects. Assumes tool call ids are unique across the conversation
 * (provider-guaranteed); a call id duplicated across distinct assistant
 * messages is malformed input outside this contract.
 *
 * @param messages - Array of messages to repair
 * @returns New array in provider-valid, canonical order
 */
export function repairDanglingMessages(messages: Message[]): Message[] {
	// ── Step 1: DROP orphaned tool messages ──
	const knownCallIds = new Set<string>()
	for (const message of messages) {
		if (hasToolCalls(message)) {
			const assistantMsg = message as AssistantMessage
			for (const toolCall of assistantMsg.toolCalls ?? []) {
				knownCallIds.add(toolCall.id)
			}
		}
	}

	const withoutOrphans = messages.filter(
		(message) => !isToolMessage(message) || knownCallIds.has((message as ToolMessage).toolCallId),
	)

	// ── Step 2: SYNTHESIZE a result for every unmatched assistant tool call ──
	const satisfiedCallIds = new Set<string>()
	for (const message of withoutOrphans) {
		if (isToolMessage(message)) {
			satisfiedCallIds.add((message as ToolMessage).toolCallId)
		}
	}

	const withSynthesized: Message[] = [...withoutOrphans]
	for (const message of withoutOrphans) {
		if (!hasToolCalls(message)) continue
		const assistant = message as AssistantMessage
		for (const toolCall of assistant.toolCalls ?? []) {
			if (satisfiedCallIds.has(toolCall.id)) continue
			satisfiedCallIds.add(toolCall.id)
			const synthesized: ToolMessage = {
				role: 'tool',
				content: MISSING_TOOL_RESULT_CONTENT,
				toolCallId: toolCall.id,
				timestamp: (assistant.timestamp ?? 0) + 1,
			}
			withSynthesized.push(synthesized)
		}
	}

	// ── Step 3: CANONICALIZE placement, keeping ONE result per call id ──
	// A provider rejects two results for the same tool call, so a duplicate is not
	// something a repair may pass through: an interrupted run that recorded a
	// result twice would stay permanently unresumable, and re-running repair would
	// emit the duplicate again on every pass. The FIRST result wins — it is the one
	// the tool actually produced; a later copy is a bookkeeping artifact
	// (ses_015 pre-freeze M4).
	const resultByCallId = new Map<string, ToolMessage>()
	for (const message of withSynthesized) {
		if (!isToolMessage(message)) continue
		const toolMsg = message as ToolMessage
		if (!resultByCallId.has(toolMsg.toolCallId)) {
			resultByCallId.set(toolMsg.toolCallId, toolMsg)
		}
	}

	const canonical: Message[] = []
	for (const message of withSynthesized) {
		if (isToolMessage(message)) continue
		canonical.push(message)
		if (!hasToolCalls(message)) continue
		const assistant = message as AssistantMessage
		for (const toolCall of assistant.toolCalls ?? []) {
			const result = resultByCallId.get(toolCall.id)
			if (result) canonical.push(result)
		}
	}

	return canonical
}

/**
 * Finds a safe index for trimming messages while preserving tool call/result atomicity.
 *
 * Given a desired trim point (maxIndex), adjusts it forward to ensure:
 * 1. The trim doesn't split a tool call/result pair
 * 2. The first message after the trim point is not a ToolMessage (orphaned result)
 * 3. All tool call/result pairs are kept intact (either fully included or fully excluded)
 *
 * Algorithm:
 * 1. Start from desired index
 * 2. Check if there's an incomplete tool call/result pair that started before the trim point
 * 3. If so, advance trim point past the complete pair
 * 4. If the new trim point starts with a tool message, advance past it
 *
 * @param messages - Array of messages to analyze
 * @param targetIndex - Desired trim point (exclusive upper bound)
 * @returns Safe trim index where message sequence is valid (at least 0, at most messages.length)
 *
 * @example
 * ```typescript
 * const messages = [
 *   { role: 'user', content: 'test' },
 *   { role: 'assistant', content: null, toolCalls: [{ id: '1', ... }] },
 *   { role: 'tool', content: 'result', toolCallId: '1' },
 *   { role: 'user', content: 'next' }
 * ]
 * const safeIdx = findSafeTrimIndex(messages, 2)
 * // Result: 3 (skips the incomplete pair at index 1-2)
 * ```
 */
export function findSafeTrimIndex(messages: Message[], targetIndex: number): number {
	// Clamp to valid bounds
	const clampedTarget = Math.max(0, Math.min(targetIndex, messages.length))

	// If no messages after trim point, safe to trim here
	if (clampedTarget >= messages.length) {
		return messages.length
	}

	// Check for incomplete tool call/result pairs that cross the trim boundary
	// Build a map of tool call IDs and whether they have results in the kept portion
	let currentIndex = clampedTarget
	let attempts = 0
	const maxAttempts = messages.length // Prevent infinite loops

	while (attempts < maxAttempts) {
		attempts++

		if (currentIndex >= messages.length) {
			break
		}

		// Check if message at currentIndex is a tool message (orphaned result)
		const currentMsg = messages[currentIndex]
		if (currentMsg && isToolMessage(currentMsg)) {
			// Skip orphaned tool message
			currentIndex++
			continue
		}

		// Check for incomplete tool call/result pairs in the kept portion [0, currentIndex)
		const keptMessages = messages.slice(0, currentIndex)
		const incompleteResult = findDanglingMessages(keptMessages)

		if (!incompleteResult.isValid) {
			// Find the maximum dangling message index
			const allDanglingIndices = [
				...incompleteResult.assistantsWithUnmatchedCalls,
				...incompleteResult.orphanedToolMessages,
			]

			if (allDanglingIndices.length === 0) {
				// No dangling messages found, but isValid is false — shouldn't happen
				break
			}

			const maxDanglingIdx = Math.max(...allDanglingIndices)

			// Move trim point past the dangling message
			currentIndex = maxDanglingIdx + 1

			// For assistant messages, also skip following tool messages from that call
			const assistantAtDanglingIdx = messages[maxDanglingIdx]
			if (assistantAtDanglingIdx && hasToolCalls(assistantAtDanglingIdx)) {
				const toolCallIds = new Set<string>()
				const assistantMsg = assistantAtDanglingIdx as {
					toolCalls?: Array<{ id: string }>
				}
				if (assistantMsg.toolCalls) {
					for (const toolCall of assistantMsg.toolCalls) {
						toolCallIds.add(toolCall.id)
					}
				}

				// Skip following tool messages from this assistant
				while (currentIndex < messages.length) {
					const nextMsg = messages[currentIndex]
					if (!nextMsg) break
					if (isToolMessage(nextMsg)) {
						const toolMsg = nextMsg as { toolCallId: string }
						if (toolCallIds.has(toolMsg.toolCallId)) {
							currentIndex++
							continue
						}
					}
					break
				}
			}
		} else {
			// No dangling messages in the kept portion, we're safe
			break
		}
	}

	return Math.min(currentIndex, messages.length)
}
