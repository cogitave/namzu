import { createHash } from 'node:crypto'
import { findRetainedIndices } from '../../compaction/retention.js'
import { estimateMessageTokens } from '../../compaction/token-estimate.js'
import { isClearedToolResult } from '../../compaction/tool-result-editing.js'
import type { ToolManager } from '../../toolsets/manager.js'
import type { Message, ToolCall, ToolMessage } from '../../types/message/index.js'

/**
 * Request-only exact observation masking. Every reference targets a full result
 * in THIS projection. Recompute from canonical history, never from yesterday's
 * mask, so removing a former representative cannot leave a dangling reference.
 * No tool executions are skipped, and equal output is not a freshness claim.
 */
export function projectObservationContext(
	messages: Message[],
	tools: Pick<ToolManager, 'get'>,
	preserveToolResultsFrom: readonly string[] = [],
	observationKey?: (call: ToolCall, message: ToolMessage) => string | undefined,
): Message[] {
	// Historical model input is not a new tool invocation. Its schema may contain
	// refinements, transforms or defaults with effects, so only an executor-owned
	// record of an actual observation may authorize request-only masking.
	if (!observationKey) return messages
	const calls = new Map<string, ToolCall | null>()
	for (const message of messages) {
		if (message.role !== 'assistant') continue
		for (const call of message.toolCalls ?? []) {
			// Ambiguous IDs cannot prove which observation belongs to which call.
			if (calls.has(call.id)) calls.set(call.id, null)
			else calls.set(call.id, call.metadata?.inputTruncated ? null : call)
		}
	}
	const resultCounts = new Map<string, number>()
	for (const message of messages) {
		if (message.role === 'tool') {
			resultCounts.set(message.toolCallId, (resultCounts.get(message.toolCallId) ?? 0) + 1)
		}
	}
	const protectedIndices = findRetainedIndices(messages)
	const representatives = new Map<string, ToolMessage>()
	let projected: Message[] | undefined
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]
		if (
			!message ||
			message.role !== 'tool' ||
			message.isError ||
			typeof message.content !== 'string' ||
			message.content.length < 1024 ||
			isClearedToolResult(message.content) ||
			resultCounts.get(message.toolCallId) !== 1
		)
			continue
		const call = calls.get(message.toolCallId)
		if (!call || preserveToolResultsFrom.includes(call.function.name)) continue
		if (!tools.get(call.function.name)) continue
		let executionKey: string | undefined
		try {
			executionKey = observationKey(call, message)
		} catch {
			// Missing or broken trusted classification leaves the full result intact.
			continue
		}
		if (executionKey === undefined) continue
		// Exact arguments intentionally: equivalent JSON with different formatting
		// is a missed optimization, not permission to merge different file ranges.
		const key = createHash('sha256')
			.update(
				JSON.stringify([
					call.function.name,
					call.function.arguments,
					message.content,
					executionKey,
				]),
			)
			.digest('hex')
		const representative = representatives.get(key)
		if (!representative) {
			representatives.set(key, message)
			continue
		}
		if (protectedIndices.has(index)) continue
		const replacement: ToolMessage = {
			...message,
			content: `[Duplicate observation: this call returned exactly the same text as tool result ${JSON.stringify(representative.toolCallId)}, whose full content remains in this request. Both calls occurred. This is historical evidence, not a claim that external state is still unchanged.]`,
		}
		if (estimateMessageTokens(replacement) >= estimateMessageTokens(message)) continue
		projected ??= [...messages]
		projected[index] = replacement
	}
	return projected ?? messages
}
