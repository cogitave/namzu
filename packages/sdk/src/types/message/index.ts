export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export type CacheHint = 'cache' | 'ephemeral' | 'none'

/**
 * An image attached to a user message (vision input). Additive: providers
 * that support vision emit it as an image content block
 * alongside the text; providers that don't simply ignore it.
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
export type MessageAttachment = ImageAttachment | DocumentAttachment

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
		inputTruncated?: boolean
		/**
		 * The partial argument buffer as it arrived, when the stream cut off
		 * mid-JSON. `function.arguments` is normalized to `"{}"` in that
		 * case so tool args stay clean, which leaves this as the only record
		 * of what the model was actually saying — and a `repairToolCall`
		 * hook has nothing to repair without it.
		 */
		partialArguments?: string
	}
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
	 * Exempt this message from compaction and from tool-result clearing.
	 *
	 * Everything the run protected before was protected by POSITION — the
	 * leading system run, the working-memory slot, the last N turns, the
	 * most recent tool results. A standing constraint stated in the middle
	 * of a conversation ("the account id is X; never bill a different
	 * one") therefore aged out at the same rate as chatter, and no
	 * positional rule could express it.
	 *
	 * Protection is transitive across a tool pair: pinning a
	 * `tool_result` also pins the assistant turn that called it, and
	 * pinning that turn pins every result answering it. Half a pair is not
	 * a smaller history, it is one the provider rejects.
	 *
	 * Pinned turns are exempt from the reclaim that keeps a long run
	 * alive, so this is a budget the setter spends. Nothing caps it: a cap
	 * would have to guess which pin mattered, and dropping the wrong one
	 * quietly is worse than a run that overflows in the open.
	 */
	retain?: boolean
}

export interface SystemMessage extends BaseMessage {
	role: 'system'
	content: string
}

export interface UserMessage extends BaseMessage {
	role: 'user'
	content: string
	/** Optional image or document attachments. */
	attachments?: readonly MessageAttachment[]
}

/**
 * An opaque reasoning block produced by the model.
 *
 * Deliberately opaque: the SDK stores and replays it, never interprets it.
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

export interface AssistantMessage extends BaseMessage {
	role: 'assistant'
	content: string | null
	toolCalls?: ToolCall[]
	/**
	 * Reasoning the model emitted before this turn's content, in order.
	 * Replayed verbatim and ahead of the text/tool blocks — see
	 * {@link ReasoningBlock}.
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
	| { readonly type: 'image'; readonly data: string; readonly mediaType: string }
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
): UserMessage {
	return {
		role: 'user',
		content,
		timestamp: Date.now(),
		...(attachments && attachments.length > 0 ? { attachments } : {}),
	}
}

export function createAssistantMessage(
	content: string | null,
	toolCalls?: ToolCall[],
	reasoning?: readonly ReasoningBlock[],
	citations?: readonly Citation[],
): AssistantMessage {
	return {
		role: 'assistant',
		content,
		toolCalls,
		...(reasoning && reasoning.length > 0 ? { reasoning } : {}),
		...(citations && citations.length > 0 ? { citations } : {}),
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

export { hasNonTextBlocks, toToolResultBlocks, toolResultToText } from './content.js'
