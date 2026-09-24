import { mergeTokenUsage } from '../types/common/index.js'
import type { ReasoningBlock, ToolInputError } from '../types/message/index.js'
import type { ChatCompletionResponse } from '../types/provider/chat.js'
import type { StreamChunk } from '../types/provider/stream.js'
import { StreamTextAccumulator } from './stream-text.js'
import {
	INTERLEAVED_TOOL_INPUT_PARSE_ERROR,
	ToolCallIndexer,
	describeToolCallFramingViolation,
	toolCallFramingViolation,
} from './tool-call-framing.js'

/**
 * Whether a streamed argument buffer is, so far, a complete JSON value: none
 * (a call with no arguments arrives empty) or text `JSON.parse` accepts.
 * Used only to tell whether a call could still have more coming — see
 * `ToolCallIndexer.interleaving` — not to validate a finished call, so it
 * does not need the offset-finding `parseToolArguments` the turn loop uses
 * for the message a model is shown.
 */
function isCompleteJsonValue(buffer: string): boolean {
	if (!buffer) return true
	try {
		JSON.parse(buffer)
		return true
	} catch {
		return false
	}
}

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
 * - ordinary text is concatenated in delta order; identified public text
 *   items are preserved and explicit final-answer items select the settled text;
 * - tool calls are bucketed by `index` into the existing
 *   `Array<{ id, function: { name, arguments } }>` shape. Arguments that
 *   arrive before the call's id belong to the call at their index and are
 *   kept; the id is filled in when it arrives. A stream that puts a second
 *   call id on an index is refused with an error naming the violation, as
 *   the turn loop refuses it: the second call's arguments used to be
 *   appended to the first's, which left one call no tool could run;
 * - reasoning blocks are bucketed by `index` the same way, because the
 *   assembled message is the thing a caller replays and
 *   {@link ReasoningBlock} is documented as replayed verbatim. This was
 *   missing: `delta.reasoning` was dropped on the floor, so a response collected
 *   through this helper came back with no reasoning even when the driver had
 *   streamed it — and a vendor that requires the blocks back on the next turn
 *   would then be sent a message that had lost them;
 * - usage and finishReason fall back to safe defaults when the provider
 *   omits them (defensive — a known vendor-SDK failure mode
 *   where `message_stop` is occasionally dropped on connection close).
 *
 * The orchestrator does NOT call this helper — it consumes the stream
 * directly so it can emit per-delta `SessionEvent`s.
 */
export async function collectChatCompletion(
	stream: AsyncIterable<StreamChunk>,
): Promise<ChatCompletionResponse> {
	let id = ''
	const model = ''
	const text = new StreamTextAccumulator()
	let replayState: unknown
	let finishReason: ChatCompletionResponse['finishReason'] = 'stop'
	let finishDetail: ChatCompletionResponse['finishDetail']
	let usage: ChatCompletionResponse['usage'] = {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}

	const toolBuckets = new Map<
		number,
		{ id: string; name: string; argsBuf: string; unreadable?: boolean }
	>()
	// Places a fragment that came without an index; see `ToolCallIndexer`.
	const toolIndexer = new ToolCallIndexer()
	// Same bucketing rule the turn loop uses (`runtime/query/iteration/
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
		if (chunk.replayState !== undefined) replayState = chunk.replayState

		text.push(chunk)

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
			// Checked BEFORE `indexOf`, which moves "most recently active" onto
			// this fragment: the call it would leave incomplete is only
			// readable before that happens.
			const interleaving = toolIndexer.interleaving(tc, (i) =>
				isCompleteJsonValue(toolBuckets.get(i)?.argsBuf ?? ''),
			)
			const index = toolIndexer.indexOf(tc)
			const open = toolBuckets.get(index)
			const violation = toolCallFramingViolation(open, tc, index)
			if (violation) {
				throw new Error(`Provider stream error: ${describeToolCallFramingViolation(violation)}`)
			}
			if (interleaving) {
				// The call that was still open when this one started: with no
				// index to tell a later id-less fragment's owner apart, it can
				// no longer be trusted either, whatever its buffer holds.
				const stuck = toolBuckets.get(interleaving.openIndex)
				if (stuck) stuck.unreadable = true
			}
			const bucket = open ?? {
				id: '',
				name: '',
				argsBuf: '',
				...(interleaving ? { unreadable: true } : {}),
			}
			if (tc.id && !bucket.id) bucket.id = tc.id
			if (tc.function?.name) bucket.name = tc.function.name
			if (tc.function?.arguments) bucket.argsBuf += tc.function.arguments
			toolBuckets.set(index, bucket)
		}

		if (chunk.finishReason) {
			finishReason = chunk.finishReason
			finishDetail = chunk.finishReason === 'length' ? chunk.finishDetail : undefined
		}
		// Merge (per-field max), not last-write-wins: a late frame that omits
		// input/cache tokens must not zero the counts captured earlier in the stream.
		if (chunk.usage) usage = mergeTokenUsage(usage, chunk.usage)
	}

	const toolCalls = [...toolBuckets.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, b]) => ({
			id: b.id,
			type: 'function' as const,
			// An interleaved call is never returned with the buffer it
			// accumulated: that buffer may hold another call's spliced-in
			// fragments, or may simply be missing whatever an id-less
			// fragment carried elsewhere instead. Normalized to `{}`, exactly
			// as the turn loop normalizes any other unreadable call.
			function: { name: b.name, arguments: b.unreadable ? '{}' : b.argsBuf },
			...(b.unreadable
				? {
						metadata: {
							inputTruncated: true,
							partialArguments: b.argsBuf,
							inputError: {
								reason: 'malformed',
								parseError: INTERLEAVED_TOOL_INPUT_PARSE_ERROR,
								length: b.argsBuf.length,
								precedingLength: 0,
							} satisfies ToolInputError,
						},
					}
				: {}),
		}))

	const reasoningBlocks: ReasoningBlock[] = [...reasoningBuckets.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, b]) => b)

	return {
		id,
		model,
		message: {
			role: 'assistant',
			content: text.text || null,
			...(text.textParts ? { textParts: text.textParts } : {}),
			toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
			...(reasoningBlocks.length > 0 ? { reasoning: reasoningBlocks } : {}),
			...(replayState !== undefined ? { replayState } : {}),
		},
		finishReason,
		...(finishDetail ? { finishDetail } : {}),
		usage,
	}
}
