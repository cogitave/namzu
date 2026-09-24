import { type Span, SpanStatusCode } from '@opentelemetry/api'
import {
	assertHostedWebSearchSupported,
	assertNativeStructuredOutputSupported,
} from '../../../provider/capabilities.js'
import { ProviderRequestError, isProviderRequestError } from '../../../provider/errors.js'
import { StreamTextAccumulator } from '../../../provider/stream-text.js'
import {
	INTERLEAVED_TOOL_INPUT_PARSE_ERROR,
	ToolCallIndexer,
	describeToolCallFramingViolation,
	describeToolCallInterleaving,
	isUnindexedFragment,
	toolCallFramingViolation,
} from '../../../provider/tool-call-framing.js'
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
import type {
	AssistantTextPart,
	Citation,
	Message,
	ReasoningBlock,
	ToolInputError,
} from '../../../types/message/index.js'
import { ProviderError } from '../../../types/provider/errors.js'
import type {
	ChatCompletionResponse,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import type { MessageStopReason } from '../../../types/session/stop-reason.js'
import { generateMessageId, generateToolCallId } from '../../../utils/id.js'
import type { Logger } from '../../../utils/logger.js'
import type { EmitEvent } from '../events.js'
import type { RequestImageIdentity } from '../request-rich-content.js'
import { streamWithProviderRejectedImageRecovery } from './provider-rejected-image.js'
import {
	type ParsedToolArguments,
	capPartialArguments,
	classifyUnreadableToolInput,
	parseToolArguments,
} from './tool-input.js'

/** One streamed tool call, gathered by its `index`. */
interface ToolCallBucket {
	id: string
	name: string
	argsBuf: string
	/** `tool_input_started` was emitted: the id and name are both known. */
	started: boolean
	completed: boolean
	/**
	 * Parsed input. `null` while the bucket is still streaming.
	 * The synthesized
	 * `ChatCompletionResponse.toolCalls[].function.arguments` is
	 * derived from this — never from the raw buffer — so the
	 * downstream executor (`runtime/query/executor.ts`) never has
	 * to re-parse an unreadable string. An unreadable tool call is
	 * surfaced as `arguments: "{}"` plus `metadata.inputTruncated`
	 * and `metadata.inputError` so tool args remain clean while the
	 * executor can still return a specific retry hint.
	 */
	parsed: unknown | null
	/**
	 * A parse that failed at `toolCallEnd`, waiting for the end of the
	 * stream, which classifies it. Cleared once classified.
	 */
	pendingFailure?: Extract<ParsedToolArguments, { ok: false }>
	inputError?: ToolInputError
	/** Characters the response streamed before this call began. */
	precedingLength: number
	/**
	 * A later id-less fragment could not have been told apart between this
	 * call and another (see `ToolCallIndexer.interleaving`). Reported
	 * `malformed` regardless of what its buffer parses to: it may hold
	 * another call's spliced-in fragments, or simply be missing whatever an
	 * id-less fragment carried elsewhere instead, and either way it is not
	 * what the model sent for this call alone.
	 */
	interleaved?: boolean
}

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
	/** Captured only for host review, at the provider-chain dispatch boundary. */
	requestMessages?: readonly Message[]
}

/**
 * Consume a provider's streaming response and emit the v3 SessionEvent
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
 * - A tool-call fragment before its call's id or name: kept in the call's
 *   buffer, keyed by index, and announced in one `tool_input_delta` right
 *   after `tool_input_started`, once both are known. It used to be dropped
 *   with a warning, and the call then failed to parse and was reported as
 *   cut off.
 * - A call whose id never arrives, on a fragment or on `toolCallEnd`: given
 *   one when the stream ends, and announced then. It used to reach the
 *   executor with an empty id and none of its arguments. Every call's
 *   `tool_input_completed` follows its `tool_input_started`, under the same
 *   id, whatever id `toolCallEnd` carries.
 * - A new id on an index another call holds: the stream is refused with a
 *   classified `ProviderRequestError` naming the violation. The second
 *   call's arguments used to be appended to the first's, and the model was
 *   told its call had been cut off.
 * - Arguments that do not parse: classified once the stream has ended, as
 *   `truncated` or `malformed` (`ToolInputError`). Only the call the model's
 *   last output went to can be `truncated`, and only when the stream reported
 *   an output limit, a content filter or nothing at all. A failed parse at
 *   `toolCallEnd` defers its `tool_input_completed` to then, because what
 *   follows the call and the finish reason arrive after the block closes.
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
	turnId: import('../../../types/ids/index.js').TurnId
	iteration: number
	messageId: import('../../../types/ids/index.js').MessageId
	usage: ChatCompletionResponse['usage']
	text: string
	textParts?: readonly AssistantTextPart[]
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
			turnId: args.turnId,
			iteration: args.iteration,
			messageId: args.messageId,
			stopReason: 'cancelled',
			usage: args.usage,
			content: args.text || undefined,
			...(args.textParts ? { textParts: args.textParts } : {}),
		})
	} catch {
		// Best effort. The cancellation is the news.
	}
}

export async function* streamProviderTurn(
	provider: LLMProvider,
	params: import('../../../types/provider/index.js').ChatCompletionParams,
	emitEvent: EmitEvent,
	drainPending: () => Generator<SessionEvent>,
	turnId: import('../../../types/ids/index.js').TurnId,
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
	imageRecovery?: {
		readonly onAccepted: (identity: RequestImageIdentity) => Promise<void>
	},
	captureRequest = false,
	/** The session the turn belongs to, named on the chat span as `gen_ai.conversation.id`. */
	sessionId?: import('../../../types/ids/index.js').SessionId,
): AsyncGenerator<SessionEvent, StreamingTurnResult> {
	assertNativeStructuredOutputSupported(provider, params)
	assertHostedWebSearchSupported(provider, params)
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
		...(sessionId !== undefined ? { [GENAI.CONVERSATION_ID]: sessionId } : {}),
		[NAMZU.TURN_ID]: turnId,
		...(params.temperature !== undefined
			? { [GENAI.REQUEST_TEMPERATURE]: params.temperature }
			: {}),
		...(params.maxTokens !== undefined ? { [GENAI.REQUEST_MAX_TOKENS]: params.maxTokens } : {}),
	})

	const messageId = announceAs ?? generateMessageId()
	await emitEvent({ type: 'message_started', turnId, iteration, messageId })
	yield* drainPending()

	let id = ''
	const model = ''
	const text = new StreamTextAccumulator()
	let finishReason: ChatCompletionResponse['finishReason'] = 'stop'
	// What the stream itself reported, if anything. `finishReason` above
	// defaults to 'stop' for the response; classifying unreadable tool input
	// needs to know a stream that reported nothing from one that finished.
	let reportedFinishReason: ChatCompletionResponse['finishReason'] | undefined
	// Which limit a 'length' finish reached, when it was the context window.
	let finishDetail: ChatCompletionResponse['finishDetail']
	let usage: ChatCompletionResponse['usage'] = {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
	// Characters the model streamed so far: text, reasoning and every tool
	// call's arguments. Each call records it as it begins, so a cut-off call's
	// share of the response says whether the call itself or what came before
	// it filled the response.
	let streamedLength = 0
	const toolBuckets = new Map<number, ToolCallBucket>()
	// Places a fragment that came without an index; see `ToolCallIndexer`.
	const toolIndexer = new ToolCallIndexer()
	// The call the model's latest output went to, or `undefined` once text,
	// reasoning or a hosted tool followed it. An output limit, a content
	// filter or a dropped stream stops the response wherever it is, so this
	// is the only call one of them can have cut off. Every other call was
	// complete when the model moved on from it.
	let lastOutputCall: ToolCallBucket | undefined
	// Announce a call once its id and name are both known: `tool_input_started`,
	// then, as one delta, whatever arguments arrived before that.
	async function* announceToolCall(bucket: ToolCallBucket): AsyncGenerator<SessionEvent, void> {
		if (bucket.started || !bucket.id || !bucket.name) return
		bucket.started = true
		await emitEvent({
			type: 'tool_input_started',
			turnId,
			iteration,
			messageId,
			toolUseId: bucket.id as ToolUseId,
			toolName: bucket.name,
		})
		yield* drainPending()
		if (bucket.argsBuf) {
			await emitEvent({
				type: 'tool_input_delta',
				turnId,
				toolUseId: bucket.id as ToolUseId,
				partialJson: bucket.argsBuf,
			})
			yield* drainPending()
		}
	}
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
	let replayState: unknown

	let streamError: string | undefined
	let streamCause: unknown
	/** The stream broke tool-call framing; nothing it sent becomes a tool call. */
	let framingViolated = false

	const streamParams = {
		...params,
		stream: true,
	} satisfies import('../../../types/provider/index.js').ChatCompletionParams
	let requestMessages: readonly Message[] | undefined
	const observeRequest = captureRequest
		? (messages: readonly Message[]) => {
				requestMessages = structuredClone(messages)
			}
		: undefined
	if (!imageRecovery) observeRequest?.(streamParams.messages)
	const stream = (
		imageRecovery
			? streamWithProviderRejectedImageRecovery(
					provider,
					streamParams,
					imageRecovery.onAccepted,
					observeRequest,
				)
			: provider.chatStream(streamParams)
	) as AsyncIterable<StreamChunk>

	// Drive the stream manually so each `.next()` can be RACED against the turn
	// abort: a Stop tears the in-flight model request down (the provider got
	// `params.signal`), and we ALSO stop pulling within a tick even if a
	// transport buffers or ignores the signal. The abort rejection propagates
	// out of this generator so the turn loop settles the turn as cancelled.
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
					turnId,
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
					turnId,
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
			if (chunk.replayState !== undefined) replayState = chunk.replayState
			text.push(chunk)

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

			if (chunk.delta.hostedTool) {
				// A hosted tool starting is the model moving on. Its later status
				// changes are not new output: a driver may report the completion
				// only once the response is over.
				if (chunk.delta.hostedTool.status === 'running') lastOutputCall = undefined
				await emitEvent({
					type: 'hosted_tool',
					turnId,
					iteration,
					tool: chunk.delta.hostedTool,
				})
				yield* drainPending()
			}
			if (chunk.delta.citation) citations.push(chunk.delta.citation)

			const reasoning = chunk.delta.reasoning
			if (reasoning) {
				let bucket = reasoningBuckets.get(reasoning.index)
				// A new reasoning block, or more of its text, is the model moving
				// on. A signature or a close is not: it ends a block already begun.
				if (!bucket || reasoning.text) lastOutputCall = undefined
				if (!bucket) {
					bucket = { type: reasoning.type ?? 'thinking', text: '' }
					reasoningBuckets.set(reasoning.index, bucket)
					await emitEvent({
						type: 'reasoning_started',
						turnId,
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
					streamedLength += reasoning.text.length
					await emitEvent({
						type: 'reasoning_delta',
						turnId,
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
						turnId,
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
				// Text a driver adds of its own, such as a list of sources, comes
				// after the model stopped. It is not the model moving on from a
				// call, and not part of what came before one.
				if (chunk.delta.contentOrigin !== 'driver') {
					streamedLength += chunk.delta.content.length
					lastOutputCall = undefined
				}
				await emitEvent({
					type: 'text_delta',
					turnId,
					iteration,
					messageId,
					text: chunk.delta.content,
					...(chunk.delta.textPart ? { textPart: chunk.delta.textPart } : {}),
				})
				yield* drainPending()
			}

			for (const tc of chunk.delta.toolCalls ?? []) {
				if (isUnindexedFragment(tc)) {
					// Neither an id nor an index: never a guess. Evaluated fresh
					// for THIS fragment, not decided once when some call opened —
					// a call's buffer stops accepting text the moment it becomes
					// one complete JSON value, and only the state right now says
					// which open calls still could be this fragment's target.
					const placement = toolIndexer.placeUnindexedFragment((i) => {
						const b = toolBuckets.get(i)
						if (!b || b.completed) return false
						return b.argsBuf === '' || !parseToolArguments(b.argsBuf).ok
					})
					if (typeof placement === 'number') {
						let bucket = toolBuckets.get(placement)
						if (!bucket) {
							bucket = {
								id: '',
								name: '',
								argsBuf: '',
								started: false,
								completed: false,
								parsed: null,
								precedingLength: streamedLength,
							}
							toolBuckets.set(placement, bucket)
							lastOutputCall = bucket
						}
						if (tc.function?.name && !bucket.name) bucket.name = tc.function.name
						const fragment = tc.function?.arguments
						if (fragment) {
							bucket.argsBuf += fragment
							streamedLength += fragment.length
							lastOutputCall = bucket
						}
						if (!bucket.started) {
							yield* announceToolCall(bucket)
						} else if (fragment) {
							await emitEvent({
								type: 'tool_input_delta',
								turnId,
								toolUseId: bucket.id as ToolUseId,
								partialJson: fragment,
							})
							yield* drainPending()
						}
					} else {
						// More than one open call could still have taken this
						// fragment, or none could: every candidate is
						// unreadable, and the fragment itself is attributed to
						// none of them — appending it to a guess is exactly the
						// splice this exists to refuse.
						for (const candidate of placement.candidates) {
							const stuck = toolBuckets.get(candidate.index)
							if (stuck) stuck.interleaved = true
						}
						log.warn('tool-call fragments arrived interleaved with no index', {
							[NAMZU.TURN_ID]: turnId,
							[NAMZU.ITERATION]: iteration,
							'exception.message': describeToolCallInterleaving({
								kind: 'interleaved_without_index',
								candidates: placement.candidates,
							}),
						})
					}
					continue
				}
				const index = toolIndexer.indexOf(tc)
				let bucket = toolBuckets.get(index)
				const violation = toolCallFramingViolation(bucket, tc, index)
				if (violation) {
					// Refused, not repaired: after either violation no buffer can be
					// trusted to hold one call's arguments, and guessing is what
					// told a model its intact call had been cut off. Thrown so the
					// stream is torn down like any other stream failure; the flag
					// keeps the recovery below from turning it into tool calls.
					framingViolated = true
					throw new ProviderRequestError({
						kind: 'server',
						providerId: provider.id,
						detail: describeToolCallFramingViolation(violation),
					})
				}
				if (!bucket) {
					bucket = {
						id: tc.id ?? '',
						name: tc.function?.name ?? '',
						argsBuf: '',
						started: false,
						completed: false,
						parsed: null,
						precedingLength: streamedLength,
					}
					toolBuckets.set(index, bucket)
					lastOutputCall = bucket
				}
				if (tc.id && !bucket.id) bucket.id = tc.id
				if (tc.function?.name && !bucket.name) bucket.name = tc.function.name

				// Arguments belong to the call at their index whether or not its
				// id has arrived yet: the index is what groups a call's fragments.
				// Until the call can be announced they are only buffered, and the
				// announcement carries them.
				const fragment = tc.function?.arguments
				if (fragment) {
					bucket.argsBuf += fragment
					streamedLength += fragment.length
					lastOutputCall = bucket
				}

				if (!bucket.started) {
					yield* announceToolCall(bucket)
				} else if (fragment) {
					await emitEvent({
						type: 'tool_input_delta',
						turnId,
						toolUseId: bucket.id as ToolUseId,
						partialJson: fragment,
					})
					yield* drainPending()
				}
			}

			if (chunk.delta.toolCallEnd) {
				const { id: endId } = chunk.delta.toolCallEnd
				const index = toolIndexer.closedIndex(chunk.delta.toolCallEnd)
				const bucket = index === undefined ? undefined : toolBuckets.get(index)
				if (bucket && !bucket.completed) {
					// The block close names the call too; a call whose id no
					// fragment carried is announced by it.
					if (!bucket.id && endId) bucket.id = endId
					yield* announceToolCall(bucket)
				}
				// Settled here only once announced, and always under the id it
				// was announced with, which is the id it runs under. A close
				// with an empty id, or for a call whose name never came, leaves
				// the call to the loop after the stream, which gives it an id
				// and announces it first. The close's own id was used here
				// before: an empty one completed a call that was not yet
				// announced, under an id no other event of the call carried.
				if (bucket?.started && !bucket.completed) {
					bucket.completed = true
					// An interleaved call is never taken at its buffer's word: it
					// may hold another call's spliced-in fragments, or be missing
					// whatever an id-less fragment carried elsewhere instead.
					const parsed = bucket.interleaved
						? { ok: false as const, parseError: INTERLEAVED_TOOL_INPUT_PARSE_ERROR }
						: parseToolArguments(bucket.argsBuf)
					if (parsed.ok) {
						bucket.parsed = parsed.value
						await emitEvent({
							type: 'tool_input_completed',
							turnId,
							toolUseId: bucket.id as ToolUseId,
							input: parsed.value,
						})
						yield* drainPending()
					} else {
						// Whether this call was cut off or malformed is decided by
						// what follows it and how the response ends, and both
						// arrive after the block closes. Its completion is emitted
						// once the stream is over.
						bucket.parsed = {}
						bucket.pendingFailure = parsed
					}
				}
			}

			if (chunk.finishReason) {
				finishReason = chunk.finishReason
				reportedFinishReason = chunk.finishReason
				finishDetail = chunk.finishReason === 'length' ? chunk.finishDetail : undefined
			}
			// Merge (per-field max), not last-write-wins: a late usage frame that
			// omits input/cache tokens must not zero the counts seen earlier in the
			// stream, which would under-report this turn's accumulated usage.
			if (chunk.usage) usage = mergeTokenUsage(usage, chunk.usage)
		}
	} catch (err) {
		// An abort tears the turn down: propagate it so the turn loop settles the
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
				turnId,
				iteration,
				messageId,
				usage,
				text: text.text,
				textParts: text.textParts,
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
		// Request cleanup on every exit, but never wait for a blocked provider's
		// pending next(). An async generator queues return() behind that pull;
		// awaiting it would undo the cancellation race above. Provider metering
		// independently records cancellation and any already-issued late receipt.
		try {
			void it.return?.().catch(() => {})
		} catch {
			// Cleanup cannot replace the original stream outcome.
		}
	}

	// A call whose id never arrived is still one call: its index grouped its
	// fragments. Only the name its result is filed under is missing, so it is
	// given one, as a driver does for a wire that sends none, and announced.
	for (const bucket of toolBuckets.values()) {
		if (bucket.id || !bucket.name) continue
		bucket.id = generateToolCallId()
		log.warn('tool call arrived without an id; one was assigned', {
			[NAMZU.TURN_ID]: turnId,
			'namzu.runtime.tool_use_id': bucket.id,
			[GENAI.TOOL_NAME]: bucket.name,
		})
		yield* announceToolCall(bucket)
	}

	// Settle every tool call the stream left open or unreadable. Two paths
	// arrive here:
	//
	//   1. No `toolCallEnd` came for the call — a driver that never emits one
	//      (every call then settles here), or a stream that stopped before
	//      the block closed. A buffer that parses is kept.
	//   2. `toolCallEnd` came and the buffer did not parse. Its completion was
	//      held back until now, because what it is depends on how the
	//      response ended.
	//
	// An unreadable buffer becomes `parsed = {}` — the safe fallback, so the
	// executor's `JSON.parse(arguments)` succeeds and nothing downstream
	// crashes — plus `inputError`. It is `truncated` only for the call the
	// model's last output went to, when the output limit or a content filter
	// stopped the response or it reported nothing at all: whatever stopped
	// the response could cut no other call. Every other unreadable call is
	// `malformed`: the response finished normally, or the model moved on to
	// more output, so it had finished writing the call. The executor turns
	// that into a message the model can act on. Without it the model got a
	// generic "<field> is required" error for a call it did not know was
	// broken, and a cut-off call came back with the same long input, into
	// the same cutoff, in a loop. Calling a malformed call cut off tells the
	// model to send less, which does not fix its JSON.
	for (const bucket of toolBuckets.values()) {
		let failure = bucket.pendingFailure
		if (!failure) {
			if (!bucket.started || bucket.completed) continue
			bucket.completed = true
			const parsed = bucket.interleaved
				? { ok: false as const, parseError: INTERLEAVED_TOOL_INPUT_PARSE_ERROR }
				: parseToolArguments(bucket.argsBuf)
			if (parsed.ok) {
				bucket.parsed = parsed.value
				await emitEvent({
					type: 'tool_input_completed',
					turnId,
					toolUseId: bucket.id as ToolUseId,
					input: parsed.value,
				})
				yield* drainPending()
				continue
			}
			failure = parsed
		}
		bucket.pendingFailure = undefined
		bucket.parsed = {}
		// An interleaved call is always `malformed`, never `classifyUnreadableToolInput`'s
		// call: whether it happens to be this response's last output and
		// whether the response was cut off are both beside the point here —
		// the buffer it would be judged by cannot be trusted either way.
		const inputError: ToolInputError = bucket.interleaved
			? {
					reason: 'malformed',
					parseError: INTERLEAVED_TOOL_INPUT_PARSE_ERROR,
					length: bucket.argsBuf.length,
					precedingLength: bucket.precedingLength,
				}
			: classifyUnreadableToolInput(
					failure,
					{
						length: bucket.argsBuf.length,
						precedingLength: bucket.precedingLength,
						last: bucket === lastOutputCall,
					},
					reportedFinishReason,
					usage,
					finishDetail,
				)
		bucket.inputError = inputError
		log.warn('tool input could not be read', {
			[NAMZU.TURN_ID]: turnId,
			'namzu.runtime.tool_use_id': bucket.id,
			[GENAI.TOOL_NAME]: bucket.name,
			'namzu.runtime.reason': inputError.reason,
			'namzu.runtime.finish_reason': reportedFinishReason ?? 'none',
			'namzu.runtime.buffer_length': bucket.argsBuf.length,
			'exception.message': inputError.parseError,
		})
		await emitEvent({
			type: 'tool_input_completed',
			turnId,
			toolUseId: bucket.id as ToolUseId,
			input: {},
			inputTruncated: true,
			inputError,
			partialArguments: capPartialArguments(bucket.argsBuf),
		})
		yield* drainPending()
	}

	// `arguments` MUST be valid JSON for the executor's `JSON.parse`
	// (`runtime/query/executor.ts:executeSingle`) to succeed. We
	// always serialise from the bucket's `parsed` object (filled by
	// either the `toolCallEnd` branch above or the post-stream flush
	// loop) instead of re-emitting `argsBuf`. When the arguments could not
	// be read, `metadata.inputTruncated` and `metadata.inputError` carry
	// that state; the executor parses cleanly and returns a specific
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
			...(b.inputError
				? {
						metadata: {
							inputTruncated: true,
							partialArguments: b.argsBuf,
							inputError: b.inputError,
						},
					}
				: {}),
		}))

	// Not after a framing violation: the calls it would recover are the ones
	// the stream was just refused for garbling.
	const recoveredToolInputFromStreamError =
		streamError !== undefined &&
		!framingViolated &&
		toolCalls.some((tc) => tc.id && tc.function.name)
	const effectiveFinishReason: ChatCompletionResponse['finishReason'] =
		recoveredToolInputFromStreamError ? 'tool_calls' : finishReason

	if (recoveredToolInputFromStreamError) {
		log.warn('provider stream failed after tool input; surfacing tool call to executor', {
			[NAMZU.TURN_ID]: turnId,
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
		turnId,
		iteration,
		messageId,
		stopReason,
		usage,
		content: text.text || undefined,
		...(text.textParts ? { textParts: text.textParts } : {}),
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
		// The newer classified shape carries the same guarantee, and the turn
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
			content: text.text || null,
			...(text.textParts ? { textParts: text.textParts } : {}),
			toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
			...(reasoningBlocks.length > 0 ? { reasoning: reasoningBlocks } : {}),
			...(replayState !== undefined ? { replayState } : {}),
			...(citations.length > 0 ? { citations } : {}),
		},
		finishReason: effectiveFinishReason,
		...(effectiveFinishReason === 'length' && finishDetail ? { finishDetail } : {}),
		usage,
	}

	// The same numbers as a MEASUREMENT, not only as a span attribute.
	// A span answers "what happened in this turn"; a metric answers "what is
	// this costing across every turn", and no amount of span attributes adds
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

	return { response, messageId, ...(requestMessages ? { requestMessages } : {}) }
}
