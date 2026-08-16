import { type Span, SpanStatusCode } from '@opentelemetry/api'
import { isProviderRequestError } from '../../../provider/errors.js'
import { GENAI, NAMZU, chatSpanName, parentContext } from '../../../telemetry/attributes.js'
import {
	recordModelDuration,
	recordTimeToFirstToken,
	recordTokenUsage,
} from '../../../telemetry/metrics.js'
import { getTracer } from '../../../telemetry/runtime-accessors.js'
import { mergeTokenUsage } from '../../../types/common/index.js'
import { NamzuError } from '../../../types/errors/index.js'
import type { ToolUseId } from '../../../types/ids/index.js'
import type { Citation, ReasoningBlock } from '../../../types/message/index.js'
import { ProviderError } from '../../../types/provider/errors.js'
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
 * Edge cases A3, A4, A5:
 * - Stream ends without `finishReason` (a known vendor-SDK failure mode
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
/**
 * Close out a turn that was cancelled part-way through.
 *
 * Everything a completed turn records, for a turn that stopped early: the
 * usage it did accumulate, the latency it did spend, the span it opened,
 * and a terminal event closing the message it announced.
 *
 * The event is emitted directly rather than yielded because this runs
 * inside a `catch` that is about to re-throw — a `yield` there would never
 * be pulled. Nothing here is allowed to throw over the cancellation: a
 * failure while tidying up must not replace the reason the turn ended.
 */
async function settleCancelledTurn(args: {
	emitEvent: EmitEvent
	runId: import('../../../types/ids/index.js').RunId
	iteration: number
	messageId: import('../../../types/ids/index.js').MessageId
	usage: ChatCompletionResponse['usage']
	text: string
	model: string
	startedAt: number
	span: Span
}): Promise<void> {
	try {
		recordTokenUsage(args.model, args.usage)
		recordModelDuration(args.model, Date.now() - args.startedAt)
		args.span.setAttributes({
			[GENAI.USAGE_INPUT_TOKENS]: args.usage.promptTokens,
			[GENAI.USAGE_OUTPUT_TOKENS]: args.usage.completionTokens,
			[NAMZU.CACHE_READ_TOKENS]: args.usage.cachedTokens ?? 0,
			[NAMZU.CACHE_WRITE_TOKENS]: args.usage.cacheWriteTokens ?? 0,
		})
		args.span.setStatus({ code: SpanStatusCode.OK })
		args.span.end()

		await args.emitEvent({
			type: 'message_completed',
			runId: args.runId,
			iteration: args.iteration,
			messageId: args.messageId,
			stopReason: 'cancelled',
			usage: args.usage,
			content: args.text || undefined,
		})
	} catch {
		// Best effort. The cancellation is the news.
	}
}

export async function* streamProviderTurn(
	provider: LLMProvider,
	params: import('../../../types/provider/index.js').ChatCompletionParams,
	emitEvent: EmitEvent,
	drainPending: () => Generator<RunEvent>,
	runId: import('../../../types/ids/index.js').RunId,
	iteration: number,
	forceFinalize: boolean,
	log: Logger,
	parentSpan?: Span,
	/**
	 * The id to announce this message under.
	 *
	 * Supplied by the loop so a turn that THROWS still leaves the caller
	 * holding the id it announced. The return value never arrives on a
	 * failure, so without this the one case where a failed step most wants
	 * to point at the event stream — a stream that died after
	 * `message_started`, having already emitted `message_completed` on the
	 * way out — is precisely the case that could not.
	 *
	 * Optional, so a caller with no use for the id is unchanged.
	 */
	announceAs?: import('../../../types/ids/index.js').MessageId,
): AsyncGenerator<RunEvent, StreamingTurnResult> {
	// The `chat {model}` span the GenAI conventions require. There was none:
	// `chatSpanName` existed with zero call sites, so a trace carried no LLM
	// latency at all and the token counts landed on the iteration span
	// instead of the operation that produced them.
	const callStartedAt = Date.now()
	let firstDeltaSeen = false
	const chatSpan = getTracer().startSpan(chatSpanName(params.model), {}, parentContext(parentSpan))
	chatSpan.setAttributes({
		[GENAI.OPERATION_NAME]: 'chat',
		[GENAI.REQUEST_MODEL]: params.model,
		...(params.temperature !== undefined
			? { [GENAI.REQUEST_TEMPERATURE]: params.temperature }
			: {}),
		...(params.maxTokens !== undefined ? { [GENAI.REQUEST_MAX_TOKENS]: params.maxTokens } : {}),
	})

	const messageId = announceAs ?? generateMessageId()
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
	// Reasoning blocks, bucketed by stream index exactly like tool calls.
	// Order matters on replay — a provider wants the assistant turn echoed
	// verbatim — so the map is drained in index order at the end.
	const reasoningBuckets = new Map<
		number,
		{
			type: 'thinking' | 'redacted_thinking'
			text: string
			signature?: string
			encrypted?: string
		}
	>()

	// Citations arrive as their own deltas, in the order the model made
	// them, and are collected verbatim: they are evidence, so reordering or
	// de-duplicating them would edit the record the reader checks against.
	const citations: Citation[] = []

	let streamError: string | undefined
	let streamCause: unknown

	const stream = provider.chatStream({
		...params,
		stream: true,
	}) as AsyncIterable<StreamChunk>

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

			// A backoff notice from the retry decorator, not output. Emitted
			// and drained here because this is the only moment the consumer
			// runs during a retry — the decorator is about to sleep, and it
			// is that silence a host cannot otherwise distinguish from a
			// hang. It carries no delta, so nothing below applies to it.
			if (chunk.retry) {
				await emitEvent({
					type: 'provider_retry',
					runId,
					iteration,
					attempt: chunk.retry.attempt,
					maxRetries: chunk.retry.maxRetries,
					delayMs: chunk.retry.delayMs,
					code: chunk.retry.code,
					...(chunk.retry.status !== undefined ? { status: chunk.retry.status } : {}),
					serverDirected: chunk.retry.serverDirected,
				})
				yield* drainPending()
				continue
			}

			// A chain swap, not output, and handled beside the retry notice
			// because it is the same kind of thing: a fact about HOW the answer
			// is being produced, arriving on the only channel open while the
			// consumer is blocked inside the provider's iterator. It carries no
			// delta, so nothing below applies to it either.
			if (chunk.fallback) {
				await emitEvent({
					type: 'provider_fallback',
					runId,
					iteration,
					fromIndex: chunk.fallback.fromIndex,
					fromProviderId: chunk.fallback.fromProviderId,
					...(chunk.fallback.fromModel !== undefined
						? { fromModel: chunk.fallback.fromModel }
						: {}),
					toIndex: chunk.fallback.toIndex,
					toProviderId: chunk.fallback.toProviderId,
					...(chunk.fallback.toModel !== undefined ? { toModel: chunk.fallback.toModel } : {}),
					code: chunk.fallback.code,
					...(chunk.fallback.status !== undefined ? { status: chunk.fallback.status } : {}),
					reason: chunk.fallback.reason,
				})
				yield* drainPending()
				continue
			}

			if (chunk.error) {
				streamError = chunk.error
				break
			}
			if (!id && chunk.id) id = chunk.id

			// The first delta of the turn, of ANY kind — text, reasoning or a
			// tool call. namzu streams, so perceived latency is dominated by
			// this number, and the request histogram measures the whole call:
			// it cannot tell a fast-first-token long generation from a
			// stalled one, which is exactly the distinction a streaming UI is
			// judged on. Keyed off the delta rather than the first chunk
			// because a provider may open with a metadata-only frame.
			if (
				!firstDeltaSeen &&
				(chunk.delta.content || chunk.delta.reasoning || chunk.delta.toolCalls?.length)
			) {
				firstDeltaSeen = true
				recordTimeToFirstToken(params.model, Date.now() - callStartedAt)
			}

			if (chunk.delta.citation) citations.push(chunk.delta.citation)

			const reasoning = chunk.delta.reasoning
			if (reasoning) {
				let bucket = reasoningBuckets.get(reasoning.index)
				if (!bucket) {
					bucket = { type: reasoning.type ?? 'thinking', text: '' }
					reasoningBuckets.set(reasoning.index, bucket)
					await emitEvent({
						type: 'reasoning_started',
						runId,
						iteration,
						messageId,
						blockIndex: reasoning.index,
						reasoningType: bucket.type,
					})
					yield* drainPending()
				}
				if (reasoning.type) bucket.type = reasoning.type
				if (reasoning.signature) bucket.signature = reasoning.signature
				if (reasoning.encrypted) bucket.encrypted = reasoning.encrypted
				if (reasoning.text) {
					bucket.text += reasoning.text
					await emitEvent({
						type: 'reasoning_delta',
						runId,
						iteration,
						messageId,
						blockIndex: reasoning.index,
						text: reasoning.text,
					})
					yield* drainPending()
				}
				if (reasoning.done) {
					await emitEvent({
						type: 'reasoning_completed',
						runId,
						iteration,
						messageId,
						blockIndex: reasoning.index,
						...(bucket.text ? { text: bucket.text } : {}),
						signed: bucket.signature !== undefined,
					})
					yield* drainPending()
				}
			}

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
							[NAMZU.RUN_ID]: runId,
							'namzu.runtime.index': tc.index,
							'namzu.runtime.length': fragment.length,
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
							[NAMZU.RUN_ID]: runId,
							'namzu.runtime.tool_use_id': endId,
							'exception.message': err instanceof Error ? err.message : String(err),
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
		if (signal?.aborted) {
			// Settle what the turn already produced BEFORE unwinding. Throwing
			// straight from here skipped everything below: the usage merged so
			// far was discarded wholesale, so every cancelled turn
			// under-reported its own cost; the span opened for this call was
			// never ended, so it never exported at all; and a host consuming
			// the message lifecycle saw a message begin and never end.
			//
			// The stream-ERROR path a few lines down already does exactly
			// this. Cancel was the one exit that skipped it, which is the
			// opposite of what its frequency deserves.
			await settleCancelledTurn({
				emitEvent,
				runId,
				iteration,
				messageId,
				usage,
				text: textBuf,
				model: params.model,
				startedAt: callStartedAt,
				span: chatSpan,
			})
			throw err
		}
		streamError = err instanceof Error ? err.message : String(err)
		// Kept, not just its text. The classification a driver produced —
		// which code, which status, whether repeating the call could work —
		// is the whole basis for settling a transient fault as PAUSED rather
		// than failed, and flattening it to a message threw all of it away.
		streamCause = err
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
	// A provider's stream never sends a block-stop for the open
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
					[NAMZU.RUN_ID]: runId,
					'namzu.runtime.tool_use_id': bucket.id,
					[GENAI.TOOL_NAME]: bucket.name,
					'namzu.runtime.buffer_length': bucket.argsBuf.length,
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
			// Carry the partial buffer alongside the flag. `arguments` is
			// normalized to `{}` above, so without this the only record of
			// what the model was actually saying is gone — and a
			// `repairToolCall` hook has nothing to repair.
			...(b.inputTruncated
				? { metadata: { inputTruncated: true, partialArguments: b.argsBuf } }
				: {}),
		}))

	const recoveredToolInputFromStreamError =
		streamError !== undefined && toolCalls.some((tc) => tc.id && tc.function.name)
	const effectiveFinishReason: ChatCompletionResponse['finishReason'] =
		recoveredToolInputFromStreamError ? 'tool_calls' : finishReason

	if (recoveredToolInputFromStreamError) {
		log.warn('provider stream failed after tool input; surfacing tool call to executor', {
			[NAMZU.RUN_ID]: runId,
			[NAMZU.ITERATION]: iteration,
			'exception.message': streamError,
			'namzu.runtime.tool_call_count': toolCalls.length,
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
		chatSpan.setStatus({ code: SpanStatusCode.ERROR, message: streamError })
		chatSpan.end()

		// A classified provider failure is rethrown AS ITSELF. Wrapping it in
		// a fresh error dropped `retryable`, `status` and `retryAfterMs`,
		// and `NamzuError`'s own default for `provider_error` is
		// not-retryable — so a 429 that had exhausted its backoff settled the
		// run FAILED, where the documented behaviour is a pause with a
		// checkpoint to resume from. `toPlatformError` already projects this
		// shape correctly; it was never reached.
		//
		// The asymmetry this fixes was visible: the same 529 raised inside
		// the compaction verifier propagates untouched and DOES pause, so
		// identical faults settled oppositely depending on whether compaction
		// happened to run that iteration.
		if (streamCause instanceof ProviderError) throw streamCause
		// The newer classified shape carries the same guarantee, and the run
		// boundary reads it to decide between a pause and a failure.
		if (isProviderRequestError(streamCause)) throw streamCause

		throw new NamzuError({
			code: 'provider_error',
			message: `Provider stream error: ${streamError}`,
			details: { model: params.model },
			// Even when the cause is not classified, keeping it means a host
			// reading the chain sees what actually happened rather than a
			// sentence about it.
			...(streamCause !== undefined ? { cause: streamCause } : {}),
		})
	}

	// Drained in stream-index order: the replay contract is about the
	// original block order, and a Map preserves insertion order, not index
	// order, when a provider interleaves blocks.
	const reasoningBlocks: ReasoningBlock[] = [...reasoningBuckets.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, bucket]) => ({
			type: bucket.type,
			...(bucket.text ? { text: bucket.text } : {}),
			...(bucket.signature ? { signature: bucket.signature } : {}),
			...(bucket.encrypted ? { encrypted: bucket.encrypted } : {}),
		}))

	const response: ChatCompletionResponse = {
		id: id || messageId,
		model: model || params.model,
		message: {
			role: 'assistant',
			content: textBuf.length > 0 ? textBuf : null,
			toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
			...(reasoningBlocks.length > 0 ? { reasoning: reasoningBlocks } : {}),
			...(citations.length > 0 ? { citations } : {}),
		},
		finishReason: effectiveFinishReason,
		usage,
	}

	// The same numbers as a MEASUREMENT, not only as a span attribute.
	// A span answers "what happened in this run"; a metric answers "what is
	// this costing across every run", and no amount of span attributes adds
	// up to the second question without a trace backend willing to
	// aggregate them.
	recordTokenUsage(params.model, usage)
	recordModelDuration(params.model, Date.now() - callStartedAt)

	// Usage belongs on the span for the call that produced it, not on the
	// iteration that happened to contain it.
	chatSpan.setAttributes({
		[GENAI.RESPONSE_MODEL]: response.model,
		[GENAI.RESPONSE_ID]: response.id,
		[GENAI.RESPONSE_FINISH_REASONS]: [response.finishReason],
		[GENAI.USAGE_INPUT_TOKENS]: usage.promptTokens,
		[GENAI.USAGE_OUTPUT_TOKENS]: usage.completionTokens,
		[NAMZU.CACHE_READ_TOKENS]: usage.cachedTokens ?? 0,
		[NAMZU.CACHE_WRITE_TOKENS]: usage.cacheWriteTokens ?? 0,
	})
	chatSpan.setStatus({ code: SpanStatusCode.OK })
	chatSpan.end()

	return { response, messageId }
}
