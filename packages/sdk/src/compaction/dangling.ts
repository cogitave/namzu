import { NamzuError } from '../types/errors/index.js'
import type { AssistantMessage, Message, ToolCall, ToolMessage } from '../types/message/index.js'

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
export function findDanglingMessages(messages: readonly Message[]): DanglingResult {
	const assistantsWithUnmatchedCalls: number[] = []
	const orphanedToolMessages: number[] = []
	const seenToolCallIds = new Set<string>()

	// Provider tool results are not joins over a conversation-wide id map.
	// They form one contiguous batch immediately after the assistant turn that
	// declared them. A future call cannot own an earlier result, and a result
	// displaced past a user/assistant/system message cannot answer backwards.
	let index = 0
	while (index < messages.length) {
		const message = messages[index]
		if (!message) {
			index++
			continue
		}

		if (!hasToolCalls(message)) {
			if (isToolMessage(message)) orphanedToolMessages.push(index)
			index++
			continue
		}

		const calls = (message as AssistantMessage).toolCalls ?? []
		const callIds = new Set<string>()
		let invalidOwner = false
		for (const call of calls) {
			if (!call.id || callIds.has(call.id) || seenToolCallIds.has(call.id)) invalidOwner = true
			callIds.add(call.id)
			seenToolCallIds.add(call.id)
		}

		let resultEnd = index + 1
		while (resultEnd < messages.length && messages[resultEnd]?.role === CONSTANTS.TOOL_ROLE) {
			resultEnd++
		}

		// Keep the last immediate result for an id. A late real result can
		// follow a synthetic cancellation result after a crash; keeping the
		// first would preserve the stale guess and discard the observed fact.
		const lastResultById = new Map<string, number>()
		for (let resultIndex = index + 1; resultIndex < resultEnd; resultIndex++) {
			const result = messages[resultIndex]
			if (result?.role === CONSTANTS.TOOL_ROLE) {
				lastResultById.set(result.toolCallId, resultIndex)
			}
		}

		const answered = new Set<string>()
		for (let resultIndex = index + 1; resultIndex < resultEnd; resultIndex++) {
			const result = messages[resultIndex]
			if (result?.role !== CONSTANTS.TOOL_ROLE) continue
			if (
				invalidOwner ||
				!callIds.has(result.toolCallId) ||
				lastResultById.get(result.toolCallId) !== resultIndex
			) {
				orphanedToolMessages.push(resultIndex)
				continue
			}
			answered.add(result.toolCallId)
		}

		if (invalidOwner || calls.some((call) => !answered.has(call.id))) {
			assistantsWithUnmatchedCalls.push(index)
		}
		index = resultEnd
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
export function removeDanglingMessages(messages: readonly Message[]): Message[] {
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

/** Counts describing a provider-valid tool-history repair. */
export interface ToolHistoryRepairReport {
	/** Earlier duplicates in an immediate result batch; the last result wins. */
	readonly duplicateToolResultsRemoved: number
	/** Results with no immediately preceding owner call. */
	readonly orphanedToolResultsRemoved: number
	/** Error results inserted for calls whose durable outcome is unavailable. */
	readonly syntheticToolResultsInserted: number
}

/** A repaired copy and the exact changes made to it. */
export interface ToolHistoryRepairResult {
	readonly messages: Message[]
	readonly report: ToolHistoryRepairReport
}

/** Whether a repair changed the provider-bound history. */
export function toolHistoryRepairChanged(report: ToolHistoryRepairReport): boolean {
	return (
		report.duplicateToolResultsRemoved > 0 ||
		report.orphanedToolResultsRemoved > 0 ||
		report.syntheticToolResultsInserted > 0
	)
}

function validateToolCallIds(messages: readonly Message[]): void {
	const seen = new Set<string>()
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const message = messages[messageIndex]
		if (message?.role !== CONSTANTS.ASSISTANT_ROLE) continue
		for (let callIndex = 0; callIndex < (message.toolCalls?.length ?? 0); callIndex++) {
			const call = message.toolCalls?.[callIndex]
			if (!call?.id) {
				throw new NamzuError({
					code: 'invalid_config',
					message: `Message history contains an empty tool-call id at messages[${messageIndex}].toolCalls[${callIndex}].`,
					details: { messageIndex, callIndex, toolCallId: call?.id ?? '' },
				})
			}
			if (seen.has(call.id)) {
				throw new NamzuError({
					code: 'invalid_config',
					message: `Message history repeats tool-call id '${call.id}' at messages[${messageIndex}].toolCalls[${callIndex}]; a signed assistant turn cannot be rewritten safely.`,
					details: { messageIndex, callIndex, toolCallId: call.id },
				})
			}
			seen.add(call.id)
		}
	}
}

function unknownOutcomeResult(call: ToolCall, assistant: AssistantMessage): ToolMessage {
	return {
		role: CONSTANTS.TOOL_ROLE,
		toolCallId: call.id,
		isError: true,
		content: `Tool execution was interrupted and no durable result is available for \`${call.function.name}\`. Its outcome is unknown. Retry only if the tool is read-only or idempotent; otherwise verify external state or ask the user before retrying.`,
		...(assistant.timestamp !== undefined ? { timestamp: assistant.timestamp } : {}),
	}
}

/**
 * Repair provider tool-pairing violations without mutating the durable input.
 *
 * Results are valid only in the contiguous run immediately after their
 * assistant call. Orphaned/displaced results are removed, earlier immediate
 * duplicates are removed in favour of the last result, and every unanswered
 * call receives a conservative error result in call order. Duplicate call ids
 * fail closed: changing ids or tool calls would invalidate opaque native replay
 * state carried by the assistant message.
 */
export function repairToolMessageHistory(messages: readonly Message[]): ToolHistoryRepairResult {
	validateToolCallIds(messages)

	const repaired: Message[] = []
	let duplicateToolResultsRemoved = 0
	let orphanedToolResultsRemoved = 0
	let syntheticToolResultsInserted = 0
	let index = 0

	while (index < messages.length) {
		const message = messages[index]
		if (!message) {
			index++
			continue
		}

		if (!hasToolCalls(message)) {
			if (isToolMessage(message)) orphanedToolResultsRemoved++
			else repaired.push(message)
			index++
			continue
		}

		const assistant = message as AssistantMessage
		const calls = assistant.toolCalls ?? []
		const callIds = new Set(calls.map((call) => call.id))
		repaired.push(assistant)

		let resultEnd = index + 1
		while (resultEnd < messages.length && messages[resultEnd]?.role === CONSTANTS.TOOL_ROLE) {
			resultEnd++
		}
		const lastResultById = new Map<string, number>()
		for (let resultIndex = index + 1; resultIndex < resultEnd; resultIndex++) {
			const result = messages[resultIndex]
			if (result?.role === CONSTANTS.TOOL_ROLE) {
				lastResultById.set(result.toolCallId, resultIndex)
			}
		}

		const answered = new Set<string>()
		for (let resultIndex = index + 1; resultIndex < resultEnd; resultIndex++) {
			const result = messages[resultIndex]
			if (result?.role !== CONSTANTS.TOOL_ROLE) continue
			if (lastResultById.get(result.toolCallId) !== resultIndex) {
				duplicateToolResultsRemoved++
				continue
			}
			if (!callIds.has(result.toolCallId)) {
				orphanedToolResultsRemoved++
				continue
			}
			repaired.push(result)
			answered.add(result.toolCallId)
		}

		for (const call of calls) {
			if (answered.has(call.id)) continue
			repaired.push(unknownOutcomeResult(call, assistant))
			syntheticToolResultsInserted++
		}
		index = resultEnd
	}

	return {
		messages: repaired,
		report: {
			duplicateToolResultsRemoved,
			orphanedToolResultsRemoved,
			syntheticToolResultsInserted,
		},
	}
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

	return alignToUserTurn(messages, Math.min(currentIndex, messages.length))
}

/**
 * Move the boundary onto a `user` message.
 *
 * The loop above advances past an orphaned `tool` message but never past
 * an `assistant` one, and after compaction the kept tail IS the start of
 * the conversation: the summary is written as a system message and the
 * drivers hoist every system message into its own request parameter, so
 * the first kept message becomes the first message on the wire. A
 * conversation that opens with an assistant turn is rejected outright.
 *
 * How often depends on the shape of the history, and the shape that
 * matters most is the worst: in a multi-step turn — the agent working
 * through several tool calls without the user speaking in between — the
 * tail alternates assistant/tool with no user message anywhere in it, so
 * essentially every boundary lands wrong. The failure is unrecoverable
 * too, because the resulting rejection is not classified as an overflow
 * and so never reaches relief. Compaction, whose whole job is keeping a
 * long run alive, becomes the thing that ends it.
 *
 * Landing on a `user` message also settles the orphan question for free:
 * a user message is never a tool result, and everything skipped past is
 * dropped along with the assistant turn that owned it.
 */
function alignToUserTurn(messages: Message[], index: number): number {
	let forward = index
	while (forward < messages.length && messages[forward]?.role !== 'user') {
		forward++
	}
	if (forward < messages.length) return forward

	// Nothing ahead. Falling back keeps MORE than asked, which costs context
	// but stays valid — except that reaching further back can re-admit the
	// dangling pairs the loop above just walked past, so a candidate only
	// counts if its own suffix is clean. Two wire invariants are in play and
	// satisfying one by breaking the other is not a fix.
	for (let back = Math.min(index, messages.length) - 1; back >= 0; back--) {
		if (messages[back]?.role !== 'user') continue
		if (findDanglingMessages(messages.slice(back)).isValid) return back
	}

	// No boundary satisfies both. The input was already unsendable, and
	// there is no cut that makes it otherwise — so keep the prior
	// behaviour of trimming past the end rather than inventing a different
	// invalid conversation to replace it with.
	return forward
}
