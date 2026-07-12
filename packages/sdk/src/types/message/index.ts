export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export type CacheHint = 'cache' | 'ephemeral' | 'none'

export interface ToolCall {
	id: string
	type: 'function'
	function: {
		name: string
		arguments: string
	}
}

export interface BaseMessage {
	role: MessageRole
	content: string | null
	timestamp?: number
	cacheHint?: CacheHint
}

/**
 * What a compaction summary knows about itself, kept OUT of its text.
 *
 * `carry` is the list of facts this summary is responsible for keeping alive —
 * this pass's verifier findings first, then those inherited from every earlier
 * pass, newest first. The next compaction pass reads this list; it never reads it
 * back out of the summary's prose. That is the whole point of the field. The
 * summary body is assembled by copying user and tool content verbatim, so any
 * marker a parser looks for in it is a marker the conversation can contain — and a
 * user message quoting the carry header used to split the parser inside the
 * serialized state, discarding everything before it. Structure that came from us
 * travels beside the text, not inside it (ses_015 pre-freeze R5 B2; the same
 * lesson ses_016 applied to model-facing frames, one layer down).
 *
 * The rendered text remains the model's copy and is display-only.
 */
export interface CompactionMeta {
	/** Carried facts, newest first. Already capped to the compaction budget. */
	carry: string[]
}

/**
 * Out-of-band annotations on a message: structure the runtime put there and will
 * read back, as data. JSON-serializable by contract — messages are persisted to
 * checkpoints and replayed from them, and anything here has to survive that round
 * trip. Never sent to a provider (adapters map `role`/`content`/`toolCalls`).
 */
export interface MessageMeta {
	compaction?: CompactionMeta
}

export interface SystemMessage extends BaseMessage {
	role: 'system'
	content: string
	meta?: MessageMeta
}

export interface UserMessage extends BaseMessage {
	role: 'user'
	content: string
}

export interface AssistantMessage extends BaseMessage {
	role: 'assistant'
	content: string | null
	toolCalls?: ToolCall[]
}

export interface ToolMessage extends BaseMessage {
	role: 'tool'
	content: string
	toolCallId: string
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

export function createUserMessage(content: string): UserMessage {
	return { role: 'user', content, timestamp: Date.now() }
}

export function createAssistantMessage(
	content: string | null,
	toolCalls?: ToolCall[],
): AssistantMessage {
	return { role: 'assistant', content, toolCalls, timestamp: Date.now() }
}

export function createToolMessage(content: string, toolCallId: string): ToolMessage {
	return { role: 'tool', content, toolCallId, timestamp: Date.now() }
}
