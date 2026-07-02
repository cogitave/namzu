import { mergeTokenUsage } from '../../../types/common/index.js'
import type { ToolUseId } from '../../../types/ids/index.js'
import type {
	ChatCompletionResponse,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { MessageStopReason } from '../../../types/run/stop-reason.js'
import { generateMessageId } from '../../../utils/id.js'
import type { Logger } from '../../../utils/logger.js'
import type { EmitEvent } from '../events.js'

/**
 * Map a provider's coarse `finishReason` plus the orchestrator's
 * `forceFinalize` flag onto the per-message {@link MessageStopReason}
 * union the v3 `message_completed` event surfaces.
 */
function synthesizeMessageStopReason(
	finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter',
	forceFinalize: boolean,
): MessageStopReason {
	if (forceFinalize) return 'forced_finalize'
	switch (finishReason) {
		case 'tool_calls':
			return 'tool_use'
		case 'length':
			return 'max_tokens'
		case 'content_filter':
			return 'refusal'
		default:
			return 'end_turn'
	}
}

export interface StreamingTurnResult {
	response: ChatCompletionResponse
	messageId: import('../../../types/ids/index.js').MessageId
}

/**
 * Consume a provider's streaming response and emit the v3 RunEvent
 * lifecycle natively (message_started → text_delta* + tool_input_*
 * → message_completed). Returns the aggregated `ChatCompletionResponse`
 * for downstream code that still expects the legacy shape (assistant
 * message construction, working-state extraction, telemetry attribute
 * stamping).
 *
 * Per-delta `emitEvent` calls are followed by a `drainPending()`
 * yield so SSE consumers see live progress instead of a burst at
 * end-of-message. The bus's ephemeral filter (D1) ensures these
 * deltas never hit transcript.jsonl.
 *
 * Edge cases (codex A3, A4, A5):
 * - Stream ends without `finishReason` (anthropic-sdk-typescript#842
 *   dropped message_stop): we still emit `message_completed` from a
 *   finally-style fall-through path with `stopReason: 'refusal'`.
 * - `tool_input_delta` with no `toolUseId` registered yet: we drop
 *   the fragment and log a warning (proxies seen to misorder events).
 * - `chunk.error`: when no tool input is recoverable, we surface as
 *   a thrown error after emitting the message_completed terminator so
 *   consumer cards still close. If a tool-use block was already open,
 *   we instead synthesize a tool call with runtime truncation metadata
 *   so the executor can return a model-readable retry hint.
 */
export async function* streamProviderTurn(
	provider: LLMProvider,
	params: import('../../../types/provider/index.js').ChatCompletionParams,
	emitEvent: EmitEvent,
	drainPending: () => Generator<RunEvent>,
	runId: import('../../../types/ids/index.js').RunId,
	iteration: number,
	forceFinalize: boolean,
	log: Logger,
): AsyncGenerator<RunEvent, StreamingTurnResult> {
	const messageId = generateMessageId()
	await emitEvent({ type: 'message_started', runId, iteration, messageId })
	yield* drainPending()

	let id = ''
	const model = ''
	let textBuf = ''
	let finishReason: ChatCompletionResponse['finishReason'] = 'stop'
	let usage: ChatCompletionResponse['usage'] = {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
	const toolBuckets = new Map<
		number,
		{
			id: string
			name: string
			argsBuf: string
			started: boolean
			completed: boolean
			/**
			 * Parsed input. `null` while the bucket is still streaming.
			 * The synthesized
			 * `ChatCompletionResponse.toolCalls[].function.arguments` is
			 * derived from this — never from the raw buffer — so the
			 * downstream executor (`runtime/query/executor.ts`) never has
			 * to re-parse a truncated string. A truncated tool call is
			 * surfaced as `arguments: "{}"` plus `metadata.inputTruncated`
			 * so tool args remain clean while the executor can still
			 * return a specific retry hint.
			 */
			parsed: unknown | null
			inputTruncated: boolean
		}
	>()
	let streamError: string | undefined

	const stream = provider.chatStream({ ...params, stream: true }) as AsyncIterable<StreamChunk>

	// Drive the stream manually so each `.next()` can be RACED against the run
	// abort: a Stop tears the in-flight model request down (the provider got
	// `params.signal`), and we ALSO stop pulling within a tick even if a
	// transport buffers or ignores the signal. The abort rejection propagates
	// out of this generator so the run loop settles the turn as cancelled.
	// `{ once: true }` keeps a multi-iteration run from leaking a listener/turn.
	const it = stream[Symbol.asyncIterator]()
	const signal = params.signal
	let onAbort: (() => void) | undefined
	const aborted: Promise<never> | undefined = signal
		? new Promise<never>((_resolve, reject) => {
				if (signal.aborted) {
					reject(signal.reason)
					return
				}
				onAbort = () => reject(signal.reason)
				signal.addEventListener('abort', onAbort, { once: true })
			})
		: undefined

	try {
		for (;;) {
			const next = it.next()
			// Neutralize the dangling loser so an eventual rejection of the
			// un-awaited `next` is never an unhandled rejection.
			if (aborted) next.catch(() => {})
			const res = await (aborted ? Promise.race([next, aborted]) : next)
			if (res.done) break
			const chunk = res.value
			if (chunk.error) {
				streamError = chunk.error
				break
			}
			if (!id && chunk.id) id = chunk.id

			if (chunk.delta.content) {
				textBuf += chunk.delta.content
				await emitEvent({
					type: 'text_delta',
					runId,
					iteration,
					messageId,
					text: chunk.delta.content,
				})
				yield* drainPending()
			}

			for (const tc of chunk.delta.toolCalls ?? []) {
				let bucket = toolBuckets.get(tc.index)
				if (!bucket) {
					bucket = {
						id: tc.id ?? '',
						name: tc.function?.name ?? '',
						argsBuf: '',
						started: false,
						completed: false,
						parsed: null,
						inputTruncated: false,
					}
					toolBuckets.set(tc.index, bucket)
				}
				if (tc.id && !bucket.id) bucket.id = tc.id
				if (tc.function?.name && !bucket.name) bucket.name = tc.function.name

				if (!bucket.started && bucket.id && bucket.name) {
					bucket.started = true
					await emitEvent({
						type: 'tool_input_started',
						runId,
						iteration,
						messageId,
						toolUseId: bucket.id as ToolUseId,
						toolName: bucket.name,
					})
					yield* drainPending()
				}

				const fragment = tc.function?.arguments
				if (fragment) {
					if (!bucket.id) {
						log.warn('tool_input_delta arrived before tool id was known; dropping fragment', {
							runId,
							index: tc.index,
							length: fragment.length,
						})
					} else {
						bucket.argsBuf += fragment
						await emitEvent({
							type: 'tool_input_delta',
							runId,
							toolUseId: bucket.id as ToolUseId,
							partialJson: fragment,
						})
						yield* drainPending()
					}
				}
			}

			if (chunk.delta.toolCallEnd) {
				const { index, id: endId } = chunk.delta.toolCallEnd
				const bucket = toolBuckets.get(index)
				if (bucket && !bucket.completed) {
					bucket.completed = true
					let parsed: unknown = {}
					try {
						parsed = bucket.argsBuf ? JSON.parse(bucket.argsBuf) : {}
					} catch (err) {
						bucket.inputTruncated = true
						log.warn('tool input JSON parse failed at content_block_stop', {
							runId,
							toolUseId: endId,
							error: err instanceof Error ? err.message : String(err),
						})
					}
					bucket.parsed = parsed
					await emitEvent({
						type: 'tool_input_completed',
						runId,
						toolUseId: endId as ToolUseId,
						input: parsed,
						...(bucket.inputTruncated ? { inputTruncated: true } : {}),
					})
					yield* drainPending()
				}
			}

			if (chunk.finishReason) finishReason = chunk.finishReason
			// Merge (per-field max), not last-write-wins: a late usage frame that
			// omits input/cache tokens must not zero the counts seen earlier in the
			// stream, which would under-report this turn's accumulated usage.
			if (chunk.usage) usage = mergeTokenUsage(usage, chunk.usage)
		}
	} catch (err) {
		// An abort tears the turn down: propagate it so the run loop settles the
		// run as cancelled rather than recording a normal (errored) turn. Any
		// other stream error is captured into the synthesized response as before.
		if (signal?.aborted) throw err
		streamError = err instanceof Error ? err.message : String(err)
	} finally {
		if (onAbort) signal?.removeEventListener('abort', onAbort)
		// Release the underlying connection on every exit (natural end, error,
		// or abort). `for await` did this implicitly on natural completion; the
		// manual drive must do it explicitly. `.return()` on an already-finished
		// provider generator is a no-op.
		await it.return?.().catch(() => {})
	}

	// Flush any tool buckets the provider failed to close (no toolCallEnd
	// arrived — defensive against providers that don't yet emit it, and
	// the load-bearing path when the provider stream ends with
	// `stop_reason: "max_tokens"` mid-`input_json_delta`. In that case
	// Anthropic's SSE never sends `content_block_stop` for the open
	// tool_use block: the upstream model ran out of completion tokens
	// before it could close the JSON literal, so the buffered
	// `argsBuf` ends with something like `"content":"…some prefix` —
	// not parseable.
	//
	// Two cases coalesce here:
	//   1. The buffer parses cleanly (the provider just forgot to emit
	//      `content_block_stop` but the args are intact) — keep parsed.
	//   2. The buffer is truncated mid-literal — `parsed = {}` is the
	//      safe fallback so the executor's `JSON.parse(arguments)`
	//      succeeds and downstream consumers don't crash. The PRICE
	//      we used to pay was the model getting back a generic
	//      "<field> is required" Zod error and not realising its
	//      previous tool call was truncated server-side, so it would
	//      retry with the SAME long input and hit the same cutoff in
	//      a loop. Detect the truncation case and mark the tool call
	//      with runtime metadata; the executor surfaces a specific
	//      "your tool call was cut off by max_tokens — retry with
	//      shorter input or split into smaller calls" message that the
	//      model can act on.
	for (const bucket of toolBuckets.values()) {
		if (bucket.started && !bucket.completed) {
			bucket.completed = true
			let parsed: unknown = {}
			let truncated = false
			if (bucket.argsBuf) {
				try {
					parsed = JSON.parse(bucket.argsBuf)
				} catch {
					// argsBuf had content but didn't parse — almost
					// certainly the max_tokens-mid-literal cutoff. Mark
					// the bucket so the executor can return a model-
					// readable hint instead of a generic Zod error.
					truncated = true
					parsed = {}
				}
			}
			bucket.parsed = parsed
			bucket.inputTruncated = truncated
			if (truncated) {
				log.warn('tool input truncated by upstream cutoff (no toolCallEnd, argsBuf unparsable)', {
					runId,
					toolUseId: bucket.id,
					toolName: bucket.name,
					bufferLength: bucket.argsBuf.length,
				})
			}
			await emitEvent({
				type: 'tool_input_completed',
				runId,
				toolUseId: bucket.id as ToolUseId,
				input: parsed,
				...(truncated ? { inputTruncated: true } : {}),
			})
			yield* drainPending()
		}
	}

	// `arguments` MUST be valid JSON for the executor's `JSON.parse`
	// (`runtime/query/executor.ts:executeSingle`) to succeed. We
	// always serialise from the bucket's `parsed` object (filled by
	// either the `toolCallEnd` branch above or the post-stream flush
	// loop) instead of re-emitting `argsBuf`. When the provider
	// stream truncated mid-input, `metadata.inputTruncated` carries that
	// state; the executor parses cleanly and returns a specific
	// model-readable retry hint instead of the generic "Invalid JSON in
	// tool arguments" intercept.
	const toolCalls = [...toolBuckets.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, b]) => ({
			id: b.id,
			type: 'function' as const,
			function: {
				name: b.name,
				arguments: JSON.stringify(b.parsed ?? {}),
			},
			...(b.inputTruncated ? { metadata: { inputTruncated: true } } : {}),
		}))

	const recoveredToolInputFromStreamError =
		streamError !== undefined && toolCalls.some((tc) => tc.id && tc.function.name)
	const effectiveFinishReason: ChatCompletionResponse['finishReason'] =
		recoveredToolInputFromStreamError ? 'tool_calls' : finishReason

	if (recoveredToolInputFromStreamError) {
		log.warn('provider stream failed after tool input; surfacing tool call to executor', {
			runId,
			iteration,
			error: streamError,
			toolCallCount: toolCalls.length,
		})
	}

	const stopReason: MessageStopReason = streamError
		? recoveredToolInputFromStreamError
			? 'tool_use'
			: 'refusal'
		: synthesizeMessageStopReason(effectiveFinishReason, forceFinalize)

	await emitEvent({
		type: 'message_completed',
		runId,
		iteration,
		messageId,
		stopReason,
		usage,
		content: textBuf || undefined,
	})
	yield* drainPending()

	if (streamError && !recoveredToolInputFromStreamError) {
		throw new Error(`Provider stream error: ${streamError}`)
	}

	const response: ChatCompletionResponse = {
		id: id || messageId,
		model: model || params.model,
		message: {
			role: 'assistant',
			content: textBuf.length > 0 ? textBuf : null,
			toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
		},
		finishReason: effectiveFinishReason,
		usage,
	}
	return { response, messageId }
}
