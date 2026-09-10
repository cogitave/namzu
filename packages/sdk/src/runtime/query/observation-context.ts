import { createHash } from 'node:crypto'
import { findRetainedIndices } from '../../compaction/retention.js'
import { estimateMessageTokens } from '../../compaction/token-estimate.js'
import { isClearedToolResult } from '../../compaction/tool-result-editing.js'
import type { Message, ToolMessage } from '../../types/message/index.js'
import type { ToolRegistryContract } from '../../types/tool/index.js'

/**
 * Request-only exact observation masking. Every reference targets a full result
 * in THIS projection. Recompute from canonical history, never from yesterday's
 * mask, so removing a former representative cannot leave a dangling reference.
 * No tool executions are skipped, and equal output is not a freshness claim.
 */
export function projectObservationContext(
	messages: Message[],
	tools: Pick<ToolRegistryContract, 'get'>,
	preserveToolResultsFrom: readonly string[] = [],
): Message[] {
	const calls = new Map<string, { name: string; arguments: string } | null>()
	for (const message of messages) {
		if (message.role !== 'assistant') continue
		for (const call of message.toolCalls ?? []) {
			// Ambiguous IDs cannot prove which observation belongs to which call.
			if (calls.has(call.id)) calls.set(call.id, null)
			else calls.set(call.id, call.metadata?.inputTruncated ? null : call.function)
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
		if (!call || preserveToolResultsFrom.includes(call.name)) continue
		const definition = tools.get(call.name)
		if (!definition) continue
		try {
			const input = definition.inputSchema.safeParse(JSON.parse(call.arguments))
			if (
				!input.success ||
				definition.isReadOnly?.(input.data) !== true ||
				definition.isDestructive?.(input.data) === true
			)
				continue
		} catch {
			// Classification is advisory; invalid input or a broken custom predicate
			// must leave evidence intact, not abort the request.
			continue
		}
		// Exact arguments intentionally: equivalent JSON with different formatting
		// is a missed optimization, not permission to merge different file ranges.
		const key = createHash('sha256')
			.update(JSON.stringify([call.name, call.arguments, message.content]))
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
