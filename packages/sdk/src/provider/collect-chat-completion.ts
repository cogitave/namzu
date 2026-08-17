import { mergeTokenUsage } from '../types/common/index.js'
import type { ReasoningBlock } from '../types/message/index.js'
import type { ChatCompletionResponse } from '../types/provider/chat.js'
import type { StreamChunk } from '../types/provider/stream.js'

/**
 * Drains a {@link StreamChunk} async iterable into the equivalent
 * non-streaming {@link ChatCompletionResponse}.
 *
 * Phase 2 of ses_001-tool-stream-events removes `LLMProvider.chat()`; the
 * four internal callers that genuinely need the aggregated view (advisory
 * executor, RouterAgent's deterministic routing decision, compaction's
 * verifier, the instrumentation wrapper) replace `provider.chat(p)` with
 * `collectChatCompletion(provider.chatStream(p))`.
 *
 * Behaviour matches the pre-removal `chat()` contract:
 * - text content is concatenated in delta order;
 * - tool calls are bucketed by `index` into the existing
 *   `Array<{ id, function: { name, arguments } }>` shape;
 * - reasoning blocks are bucketed by `index` the same way, because the
 *   assembled message is the thing a caller replays and
 *   {@link ReasoningBlock} is documented as replayed verbatim. This was
 *   missing: `delta.reasoning` was dropped on the floor, so a run collected
 *   through this helper came back with no reasoning even when the driver had
 *   streamed it — and a vendor that requires the blocks back on the next turn
 *   would then be sent a message that had lost them;
 * - usage and finishReason fall back to safe defaults when the provider
 *   omits them (defensive — a known vendor-SDK failure mode
 *   where `message_stop` is occasionally dropped on connection close).
 *
 * The orchestrator does NOT call this helper — it consumes the stream
 * directly so it can emit per-delta `RunEvent`s.
 */
export async function collectChatCompletion(
	stream: AsyncIterable<StreamChunk>,
): Promise<ChatCompletionResponse> {
	let id = ''
	const model = ''
	let content = ''
	let finishReason: ChatCompletionResponse['finishReason'] = 'stop'
	let usage: ChatCompletionResponse['usage'] = {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}

	const toolBuckets = new Map<number, { id: string; name: string; argsBuf: string }>()
	// Same bucketing rule the run loop uses (`runtime/query/iteration/
	// stream-turn.ts`), so a message assembled here and a message assembled
	// there carry the same blocks in the same order.
	const reasoningBuckets = new Map<
		number,
		{ -readonly [K in keyof ReasoningBlock]: ReasoningBlock[K] } & { text: string }
	>()

	for await (const chunk of stream) {
		if (chunk.error) {
			throw new Error(chunk.error)
		}
		if (!id && chunk.id) id = chunk.id

		if (chunk.delta.content) {
			content += chunk.delta.content
		}

		const reasoning = chunk.delta.reasoning
		if (reasoning) {
			const bucket = reasoningBuckets.get(reasoning.index) ?? {
				type: reasoning.type ?? 'thinking',
				text: '',
			}
			if (reasoning.type) bucket.type = reasoning.type
			if (reasoning.text) bucket.text += reasoning.text
			if (reasoning.signature) bucket.signature = reasoning.signature
			if (reasoning.encrypted) bucket.encrypted = reasoning.encrypted
			reasoningBuckets.set(reasoning.index, bucket)
		}

		for (const tc of chunk.delta.toolCalls ?? []) {
			const bucket = toolBuckets.get(tc.index) ?? {
				id: '',
				name: '',
				argsBuf: '',
			}
			if (tc.id) bucket.id = tc.id
			if (tc.function?.name) bucket.name = tc.function.name
			if (tc.function?.arguments) bucket.argsBuf += tc.function.arguments
			toolBuckets.set(tc.index, bucket)
		}

		if (chunk.finishReason) finishReason = chunk.finishReason
		// Merge (per-field max), not last-write-wins: a late frame that omits
		// input/cache tokens must not zero the counts captured earlier in the stream.
		if (chunk.usage) usage = mergeTokenUsage(usage, chunk.usage)
	}

	const toolCalls = [...toolBuckets.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, b]) => ({
			id: b.id,
			type: 'function' as const,
			function: { name: b.name, arguments: b.argsBuf },
		}))

	const reasoningBlocks: ReasoningBlock[] = [...reasoningBuckets.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, b]) => b)

	return {
		id,
		model,
		message: {
			role: 'assistant',
			content: content.length > 0 ? content : null,
			toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
			...(reasoningBlocks.length > 0 ? { reasoning: reasoningBlocks } : {}),
		},
		finishReason,
		usage,
	}
}
