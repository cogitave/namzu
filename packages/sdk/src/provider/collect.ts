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
 * `collect(provider.chatStream(p))`.
 *
 * Behaviour matches the pre-removal `chat()` contract:
 * - text content is concatenated in delta order;
 * - tool calls are bucketed by `index` into the existing
 *   `Array<{ id, function: { name, arguments } }>` shape;
 * - usage and finishReason fall back to safe defaults when the provider
 *   omits them (defensive — see anthropics/anthropic-sdk-typescript#842
 *   where `message_stop` is occasionally dropped on connection close).
 *
 * The orchestrator does NOT call this helper — it consumes the stream
 * directly so it can emit per-delta `RunEvent`s.
 */
export async function collect(stream: AsyncIterable<StreamChunk>): Promise<ChatCompletionResponse> {
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

	for await (const chunk of stream) {
		if (chunk.error) {
			throw new Error(chunk.error)
		}
		if (!id && chunk.id) id = chunk.id

		if (chunk.delta.content) {
			content += chunk.delta.content
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
		if (chunk.usage) usage = chunk.usage
	}

	const toolCalls = [...toolBuckets.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, b]) => ({
			id: b.id,
			type: 'function' as const,
			function: { name: b.name, arguments: b.argsBuf },
		}))

	return {
		id,
		model,
		message: {
			role: 'assistant',
			content: content.length > 0 ? content : null,
			toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
		},
		finishReason,
		usage,
	}
}
