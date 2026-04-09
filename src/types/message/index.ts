export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

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

export function createSystemMessage(content: string): SystemMessage {
	return { role: 'system', content, timestamp: Date.now() }
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
