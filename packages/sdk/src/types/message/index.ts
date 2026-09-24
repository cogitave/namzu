import type { GoalId, MessageId } from '../ids/index.js'

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export type CacheHint = 'cache' | 'ephemeral' | 'none'

/** Why durable rich content must not be sent to a model again. */
export interface ModelContentOmission {
	readonly reason: 'provider-rejected' | 'invalid-image'
}

/** Runtime validation for persisted model-delivery metadata. */
export function isModelContentOmission(value: unknown): value is ModelContentOmission {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		((value as { readonly reason?: unknown }).reason === 'provider-rejected' ||
			(value as { readonly reason?: unknown }).reason === 'invalid-image')
	)
}

/**
 * An image attached to a user message (vision input). Drivers that declare
 * vision support emit it alongside the text. A shipped driver that cannot
 * map it refuses or causes the runtime to warn according to capability
 * policy; silently ignoring image bytes is not a supported fallback.
 */
export interface ImageAttachment {
	/**
	 * Optional, and optional forever: an attachment without a discriminant
	 * is an image, which is what every attachment was before documents
	 * existed. Requiring it would have broken every caller to describe a
	 * default they were already relying on.
	 */
	readonly type?: 'image'
	/** Base64-encoded image bytes (no `data:` URI prefix). */
	readonly data: string
	/** IANA media type, e.g. `image/png`, `image/jpeg`, `image/webp`. */
	readonly mediaType: string
	/** Durable delivery state; the original image bytes remain in history. */
	readonly modelOmission?: ModelContentOmission
}

/**
 * A document attached to a user message.
 *
 * Documents existed in the type system only in the TOOL-RESULT direction,
 * so "here is the contract, answer questions about it" was reachable only
 * by having a tool read the file and stringify it. That loses the
 * provider's native document handling — page structure, built-in OCR,
 * citations — and pays the text cost instead.
 */
export interface DocumentAttachment {
	readonly type: 'document'
	/**
	 * Ask the model to cite this document when it uses it.
	 *
	 * Opt-in, because it is not free: the provider splits the document
	 * into citable units and the answer carries the passages it leaned
	 * on, which costs tokens on a turn that may not need them.
	 *
	 * Citations come back on the assistant message, not in its text —
	 * see {@link Citation}.
	 */
	readonly citations?: boolean
	/** Base64-encoded bytes (no `data:` URI prefix). */
	readonly data: string
	/** IANA media type, e.g. `application/pdf`. */
	readonly mediaType: string
	/** Shown to the model, so it can refer to the file by name. */
	readonly name?: string
}

/**
 * Where a passage the model cited came from.
 *
 * Sending a document buys the provider's native handling of it — page
 * structure, built-in OCR, and the ability to say WHICH passage an
 * answer rests on. namzu could send the document and could not receive
 * the third: an answer about a contract arrived as prose, and checking
 * it meant reading the contract again by hand. A citation is the
 * difference between an answer you trust and one you verify.
 *
 * The location is a union rather than a page number because providers
 * segment differently and the segmentation is theirs: pages for a
 * paginated document, character offsets for plain text, block indices
 * for something already structured. Flattening them all to "page" would
 * invent a number for the two that have none.
 */
export interface Citation {
	/** The passage itself, verbatim from the source. */
	readonly citedText: string
	/** Which attachment, by position in the message that carried it. */
	readonly documentIndex: number
	readonly documentTitle?: string
	readonly location:
		| { readonly kind: 'page'; readonly start: number; readonly end: number }
		| { readonly kind: 'char'; readonly start: number; readonly end: number }
		| { readonly kind: 'block'; readonly start: number; readonly end: number }
}

/** What a user message may carry alongside its text. */
/**
 * An attachment whose bytes are held by a store, not by the message.
 *
 * Structural rather than an import from `store/attachment`, so this types
 * module keeps depending on nothing — the same reasoning `ToolRegistryRef`
 * gives. `store/attachment` owns the resolution and its refusals; this is
 * the shape a message may carry.
 *
 * Inline base64 puts the bytes in the durable transcript, in every
 * checkpoint, in every compaction pass, and — because a conversation
 * resends its history — on the wire once per turn. A 4 MB PDF attached once
 * is 4 MB per request for the rest of the turn.
 */
export interface StoredAttachmentRef {
	readonly type: 'stored'
	/** Opaque to the kernel. Meaningful to the store that minted it. */
	readonly ref: string
	readonly mediaType: string
	/** Which kind of content block to build once the bytes arrive. */
	readonly kind: 'image' | 'document'
	readonly name?: string
	readonly citations?: boolean
}

export type MessageAttachment = ImageAttachment | DocumentAttachment | StoredAttachmentRef

export const isDocumentAttachment = (
	attachment: MessageAttachment,
): attachment is DocumentAttachment => attachment.type === 'document'

export interface ToolCall {
	id: string
	type: 'function'
	function: {
		name: string
		arguments: string
	}
	/**
	 * Runtime-only execution annotations. This is intentionally separate
	 * from `function.arguments`: tool arguments remain the model-authored
	 * JSON payload, while provider/runtime recovery state lives here.
	 */
	metadata?: {
		/**
		 * The streamed arguments could not be read, and `function.arguments`
		 * was normalized to `"{}"`. Set for every unreadable call, cut off or
		 * malformed alike: the name predates that distinction, and
		 * {@link inputError} is what says which it was.
		 */
		inputTruncated?: boolean
		/**
		 * The argument buffer as it arrived, when it could not be read.
		 * `function.arguments` is normalized to `"{}"` in that case so tool
		 * args stay clean, which leaves this as the only record of what the
		 * model was actually saying — and a `repairToolCall` hook has nothing
		 * to repair without it.
		 */
		partialArguments?: string
		/**
		 * Why the arguments could not be read. Present with
		 * {@link inputTruncated} on every call the runtime marked; absent on a
		 * call marked by an older runtime, which recorded only the flag.
		 */
		inputError?: ToolInputError
	}
}

/**
 * Why a streamed tool call's arguments could not be read. See
 * {@link ToolInputError}.
 */
export type ToolInputErrorReason = 'truncated' | 'malformed'

/**
 * A tool call whose streamed arguments did not parse as JSON, and why.
 *
 * An output limit, a content filter or a dropped stream stops a response
 * wherever it is, so only the call the response was streaming at that moment
 * can have been cut off: the last one, with nothing the model streamed after
 * it. For that call the finish reason decides, never the text:
 *
 * - `truncated` — the response stopped before the model closed the
 *   arguments. It reached its output limit (`finishReason: 'length'`), a
 *   content filter stopped it (`'content_filter'`), or the stream ended
 *   without reporting a finish reason at all.
 * - `malformed` — the response finished normally (`'stop'` or
 *   `'tool_calls'`) and the arguments still were not valid JSON.
 *
 * Every other unreadable call is `malformed`, whatever the finish reason:
 * the model moved on to more text, reasoning or another call, so it had
 * finished writing this one.
 */
export interface ToolInputError {
	readonly reason: ToolInputErrorReason
	/** How the response ended, as the provider reported it. Absent when the stream reported nothing. */
	readonly finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter'
	/**
	 * `'context_window'` when a `'length'` finish was the model's context
	 * window rather than its output token limit (`StreamChunk.finishDetail`).
	 */
	readonly finishDetail?: 'context_window'
	/** The JSON parser's own message. */
	readonly parseError: string
	/**
	 * Zero-based character offset in the arguments where parsing failed: the
	 * first character that cannot continue valid JSON, or their length when
	 * the text simply ended. Found by scanning the arguments, so it is there
	 * when {@link parseError} names no position, as for a bare `True` or
	 * `None`.
	 */
	readonly offset?: number
	/** How many characters of arguments arrived. */
	readonly length: number
	/**
	 * How many characters the response streamed before this call began: its
	 * text, its visible reasoning and the arguments of earlier tool calls.
	 * Text a driver adds of its own is not counted. For a `truncated` call,
	 * which nothing followed, this plus {@link length} is everything the
	 * response streamed as text. It is not everything the response spent:
	 * reasoning a provider does not stream (encrypted, summarised, or only
	 * counted) uses the output limit too, and {@link outputTokens} and
	 * {@link reasoningTokens} are what show it.
	 */
	readonly precedingLength: number
	/**
	 * The output tokens the whole response used, reasoning included, as the
	 * provider reported them when it ended. Present on a `truncated` call when
	 * the provider reported any.
	 *
	 * After an output limit it says whether the visible text accounts for the
	 * limit: when most of the output went to reasoning, or to anything else
	 * the stream did not carry, the call is not what filled the response, and
	 * the model is told so rather than told to shrink the call.
	 */
	readonly outputTokens?: number
	/**
	 * Of {@link outputTokens}, the tokens the provider says went to reasoning.
	 * Present only when the provider reports that split; absent means unknown,
	 * not zero.
	 */
	readonly reasoningTokens?: number
}

export interface BaseMessage {
	/**
	 * Widened from `string | null` so `ToolMessage` can carry content
	 * blocks. Each variant below narrows it back to exactly what that role
	 * may hold, so no caller loses type safety — only the shared base is
	 * permissive.
	 */
	role: MessageRole
	content: string | null | readonly ToolResultBlock[]
	timestamp?: number
	cacheHint?: CacheHint
	/**
	 * The id of the durable `message` record this message was written as, or
	 * a `message_replaced` record's `targetMessageId` when a guardrail,
	 * review or structured-output override replaced its content in place.
	 * Absent means the kernel has not recorded this exact message: a host
	 * just constructed it, or it is a compaction's own summary (a bulk
	 * spilled or inline array, which carries no per-message id — see
	 * `docs/sdk/session-log.md`).
	 *
	 * Set by the kernel alone, never by a caller: `query()` stamps every
	 * message it folds from the session log or records fresh, on `Turn.messages`,
	 * on the messages `onConversationMessages` reports, and on a checkpoint's
	 * restored messages. A caller that mints its own id here gets `conflict`
	 * on the next turn — this log never recorded it under that name.
	 */
	readonly id?: MessageId
	/**
	 * Exempt this message from compaction and from tool-result clearing.
	 *
	 * Everything the turn protected before was protected by POSITION — the
	 * leading system run, the working-memory slot, the last N turns, the
	 * most recent tool results. A standing constraint stated in the middle
	 * of a conversation ("the account id is X; never bill a different
	 * one") therefore aged out at the same rate as chatter, and no
	 * positional rule could express it.
	 *
	 * Protection is transitive across a provider-valid turn: pinning an
	 * assistant message also pins the user message that opened its turn;
	 * pinning a `tool_result` additionally pins the assistant turn that called
	 * it, and pinning that call pins every result answering it. Half a pair,
	 * or an assistant-first retained tail, is not a smaller history — it is
	 * one the provider rejects.
	 *
	 * Pinned turns are exempt from the reclaim that keeps a long turn
	 * alive, so this is a budget the setter spends. Nothing caps it: a cap
	 * would have to guess which pin mattered, and dropping the wrong one
	 * quietly is worse than a turn that overflows in the open.
	 */
	retain?: boolean
}

export interface SystemMessage extends BaseMessage {
	role: 'system'
	content: string
	/** Host provenance for a derived summary, independent of its textual heading. */
	source?: { readonly type: 'compaction-summary' }
}

export interface UserMessage extends BaseMessage {
	role: 'user'
	content: string
	/** Optional image or document attachments. */
	attachments?: readonly MessageAttachment[]
	/** Host provenance for user-role input that was not authored by the operator. */
	source?: UserMessageSource
}

/** One automatic continuation prompt admitted against a durable SessionGoal. */
export interface GoalRoundMessageSource {
	readonly type: 'goal-round'
	readonly goalId: GoalId
	readonly objective: string
	/** Post-admission goal revision that authorized this prompt. */
	readonly goalRevision: number
	readonly round: number
	readonly maxGoalRounds: number
}

/**
 * A host-owned snapshot of the instruction files currently in force.
 *
 * Paths are canonical project-relative `AGENTS.md` paths. The text lives on
 * the user message itself; the paths are provenance used to re-read the
 * authoritative files after a restart rather than trusting persisted prose as
 * standing policy.
 */
export interface ProjectInstructionMessageSource {
	readonly type: 'project-instructions'
	readonly files: readonly string[]
}

/**
 * Why the runtime, rather than the operator, inserted one user-role message.
 *
 * Providers require several pieces of host context to occupy the `user` role:
 * a continuation after an output ceiling, reviewer feedback, task completion
 * notices, and similar prompts. Role alone therefore cannot answer who wrote a
 * durable message. Keeping that provenance on the message prevents a resumed
 * transcript, export, or previous-prompt editor from presenting kernel context
 * as something the operator typed.
 */
export const RUNTIME_CONTEXT_MESSAGE_KINDS = [
	'advisory',
	'answer-review',
	'auto-continuation',
	'job-exit',
	'limit-finalization',
	'repeat-call',
	'steering',
	'step-context',
	'structured-output',
	'task-completion',
] as const

export type RuntimeContextMessageKind = (typeof RUNTIME_CONTEXT_MESSAGE_KINDS)[number]

/** Host-generated context carried in the provider's required user role. */
export interface RuntimeContextMessageSource {
	readonly type: 'runtime-context'
	readonly kind: RuntimeContextMessageKind
}

export type UserMessageSource =
	| GoalRoundMessageSource
	| ProjectInstructionMessageSource
	| RuntimeContextMessageSource

/** A bounded source list keeps untrusted persisted metadata cheap to validate. */
export const MAX_PROJECT_INSTRUCTION_SOURCE_FILES = 256

/** Runtime validation for persisted or JavaScript-authored instruction provenance. */
export function isProjectInstructionMessageSource(
	value: unknown,
): value is ProjectInstructionMessageSource {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const candidate = value as {
		readonly type?: unknown
		readonly files?: unknown
	}
	if (
		candidate.type !== 'project-instructions' ||
		!Array.isArray(candidate.files) ||
		candidate.files.length === 0 ||
		candidate.files.length > MAX_PROJECT_INSTRUCTION_SOURCE_FILES
	) {
		return false
	}
	const seen = new Set<string>()
	for (const file of candidate.files) {
		if (typeof file !== 'string' || file.length === 0 || file.length > 1024) return false
		if (
			file.includes('\\') ||
			file.startsWith('/') ||
			/^[A-Za-z]:/.test(file) ||
			file.includes('\0') ||
			(file !== 'AGENTS.md' && !file.endsWith('/AGENTS.md'))
		) {
			return false
		}
		const parts = file.split('/')
		if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) return false
		if (seen.has(file)) return false
		seen.add(file)
	}
	return true
}

/** Runtime validation for durable host-generated user-message provenance. */
export function isRuntimeContextMessageSource(
	value: unknown,
): value is RuntimeContextMessageSource {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const candidate = value as {
		readonly type?: unknown
		readonly kind?: unknown
	}
	return (
		candidate.type === 'runtime-context' &&
		typeof candidate.kind === 'string' &&
		(RUNTIME_CONTEXT_MESSAGE_KINDS as readonly string[]).includes(candidate.kind)
	)
}

/**
 * The configured model route that produced or is about to receive a message.
 *
 * `chainIndex` is part of the identity on purpose: one chain may contain the
 * same provider and model more than once with different credentials or base
 * URLs. Names alone do not prove that provider-native replay state belongs to
 * the target member.
 */
export interface ProviderRoute {
	readonly providerId: string
	readonly model: string
	/** 0 is the primary provider; later values are declared fallbacks. */
	readonly chainIndex: number
}

/** Provenance and adapter-private replay state for a model-produced message. */
export interface AssistantMessageSource extends ProviderRoute {
	readonly type: 'model'
	/**
	 * Lossless-JSON state a provider adapter needs to restore native response
	 * metadata such as reasoning signatures.
	 *
	 * Opaque to the SDK. A target adapter must validate its kind, version,
	 * route, and correspondence with the durable message before using it.
	 * Missing or unusable state means provider-neutral history, never inferred
	 * native replay from matching names alone.
	 */
	readonly replayState?: unknown
}

/**
 * An opaque reasoning block produced by the model.
 *
 * Deliberately opaque: the SDK stores it and leaves native replay to the
 * adapter that owns the message's {@link AssistantMessageSource} route.
 * A provider whose reasoning blocks are signed requires the preceding
 * assistant turn to be echoed back **verbatim** — thinking blocks and
 * their cryptographic `signature` included — whenever a `tool_result`
 * follows. namzu's drivers *rebuilt* each assistant turn as
 * `[text?, ...tool_use]`, which is exactly the pattern such a contract
 * prohibits, and `AssistantMessage` had nowhere to keep a signature
 * even if a driver had parsed one.
 *
 * The requirement is not one vendor's quirk: dropping reasoning items
 * costs measurable multi-step accuracy wherever they are signed.
 */
export interface ReasoningBlock {
	readonly type: 'thinking' | 'redacted_thinking'
	readonly text?: string
	/** Cryptographic signature; replaying it unchanged is mandatory. */
	readonly signature?: string
	/** Opaque payload for the ZDR / stateless path. */
	readonly encrypted?: string
}

/** Ordered public assistant text items; these are not private reasoning blocks. */
export interface AssistantTextPart {
	readonly id: string
	readonly text: string
	readonly phase?: 'commentary' | 'final_answer'
}

/** Select explicit final answers, retaining unphased behavior when none is identified. */
export function selectAssistantText(parts: readonly AssistantTextPart[]): string {
	const final = parts.filter((part) => part.phase === 'final_answer')
	return (final.length ? final : parts).map((part) => part.text).join('\n\n')
}

export interface AssistantMessage extends BaseMessage {
	role: 'assistant'
	content: string | null
	/** Original ordered text items, including commentary excluded from the selected answer. */
	textParts?: readonly AssistantTextPart[]
	toolCalls?: ToolCall[]
	/** Which configured model route produced this turn. */
	source?: AssistantMessageSource
	/**
	 * Reasoning the model emitted before this turn's content, in order.
	 * Stored verbatim; native replay additionally requires validated
	 * {@link AssistantMessageSource.replayState} owned by the target route.
	 */
	reasoning?: readonly ReasoningBlock[]
	/**
	 * Passages this turn rests on, when the request asked for them.
	 *
	 * On the message rather than inside its text: the text is what a
	 * human reads and the citations are what a checker follows, and
	 * splicing markers into the prose would make the answer worse to read
	 * in exchange for making it machine-checkable. Empty and absent mean
	 * the same thing — the model cited nothing.
	 */
	citations?: readonly Citation[]
}

/**
 * A block of tool-result content the model can actually perceive.
 *
 * `ToolMessage.content` was `string`, so anything non-textual had to be
 * stringified to reach the model. `@namzu/computer-use`'s `screenshot`
 * returned ~400 KB–2.7 MB of base64 as TEXT — roughly 100k–670k tokens of
 * characters no model can decode — and every MCP `image`/`resource` block
 * was silently dropped by the adapter. Computer use was, in practice,
 * non-functional.
 */
export type ToolResultBlock =
	| { readonly type: 'text'; readonly text: string }
	| {
			readonly type: 'image'
			readonly data: string
			readonly mediaType: string
			readonly modelOmission?: ModelContentOmission
	  }
	| DocumentAttachment

/**
 * String stays a first-class shape, not a deprecated one: it is the
 * overwhelmingly common case, and keeping it means every existing tool and
 * driver compiles unchanged while the block array is added beside it.
 */
export type ToolResultContent = string | readonly ToolResultBlock[]

export interface ToolMessage extends BaseMessage {
	role: 'tool'
	content: ToolResultContent
	toolCallId: string
	/**
	 * Marks the result as a failure on the wire — each provider spells it
	 * differently (`is_error`, `status: 'error'`), and every driver has
	 * somewhere to put it.
	 *
	 * The executor already computed this and routed it to the SSE bridge,
	 * the A2A bridge and the TUI — then dropped it at the provider
	 * boundary, so the model's trained tool-failure recovery path never
	 * fired and namzu relied on prose formatting to convey failure.
	 */
	isError?: boolean
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage

export function createSystemMessage(content: string, cacheHint?: CacheHint): SystemMessage {
	return {
		role: 'system',
		content,
		timestamp: Date.now(),
		...(cacheHint !== undefined && { cacheHint }),
	}
}

export function createUserMessage(
	content: string,
	attachments?: readonly MessageAttachment[],
	source?: UserMessageSource,
): UserMessage {
	return {
		role: 'user',
		content,
		timestamp: Date.now(),
		...(attachments && attachments.length > 0 ? { attachments } : {}),
		...(source ? { source } : {}),
	}
}

/** Build provider-visible context that no operator authored. */
export function createRuntimeContextMessage(
	content: string,
	kind: RuntimeContextMessageKind,
): UserMessage {
	return createUserMessage(content, undefined, {
		type: 'runtime-context',
		kind,
	})
}

/** Build the retained user-context message that carries live project policy. */
export function createProjectInstructionMessage(
	content: string,
	files: readonly string[],
): UserMessage {
	const source: ProjectInstructionMessageSource = {
		type: 'project-instructions',
		files,
	}
	if (!isProjectInstructionMessageSource(source)) {
		throw new TypeError(
			'Project instruction paths must be unique, canonical project-relative paths.',
		)
	}
	return { ...createUserMessage(content, undefined, source), retain: true }
}

export function createAssistantMessage(
	content: string | null,
	toolCalls?: ToolCall[],
	reasoning?: readonly ReasoningBlock[],
	citations?: readonly Citation[],
	source?: AssistantMessageSource,
	textParts?: readonly AssistantTextPart[],
): AssistantMessage {
	return {
		role: 'assistant',
		content,
		toolCalls,
		...(reasoning && reasoning.length > 0 ? { reasoning } : {}),
		...(citations && citations.length > 0 ? { citations } : {}),
		...(source ? { source } : {}),
		...(textParts ? { textParts } : {}),
		timestamp: Date.now(),
	}
}

export function createToolMessage(
	content: ToolResultContent,
	toolCallId: string,
	isError?: boolean,
): ToolMessage {
	return {
		role: 'tool',
		content,
		toolCallId,
		...(isError !== undefined ? { isError } : {}),
		timestamp: Date.now(),
	}
}

export {
	hasNonTextBlocks,
	toToolResultBlocks,
	toolResultToText,
} from './content.js'
