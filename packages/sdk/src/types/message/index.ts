export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export type CacheHint = 'cache' | 'ephemeral' | 'none'

/**
 * An image attached to a user message (vision input). Additive: providers
 * that support vision emit it as an image content block
 * alongside the text; providers that don't simply ignore it.
 */
export interface ImageAttachment {
	/** Base64-encoded image bytes (no `data:` URI prefix). */
	readonly data: string
	/** IANA media type, e.g. `image/png`, `image/jpeg`, `image/webp`. */
	readonly mediaType: string
}

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
}

export interface SystemMessage extends BaseMessage {
	role: 'system'
	content: string
}

export interface UserMessage extends BaseMessage {
	role: 'user'
	content: string
	/** Optional image attachments (vision input). */
	attachments?: readonly ImageAttachment[]
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
	| {
			readonly type: 'document'
			readonly data: string
			readonly mediaType: string
			readonly name?: string
	  }

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
	attachments?: readonly ImageAttachment[],
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
): AssistantMessage {
	return {
		role: 'assistant',
		content,
		toolCalls,
		...(reasoning && reasoning.length > 0 ? { reasoning } : {}),
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
