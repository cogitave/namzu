export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export type CacheHint = 'cache' | 'ephemeral' | 'none'

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
	}
}

export interface BaseMessage {
	role: MessageRole
	content: string | null
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
