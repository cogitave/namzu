import type { AssistantMessage, Message } from '../types/message/index.js'

export function extractFinalResponse(messages: Message[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (!msg) continue
		if (
			msg.role === 'assistant' &&
			msg.content !== null &&
			msg.content !== undefined &&
			msg.content.length > 0
		) {
			return msg as AssistantMessage
		}
	}
	return undefined
}
