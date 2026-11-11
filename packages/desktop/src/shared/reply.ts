import type { ChatMessage } from './protocol.js'

/** The last completed final answer, which is the text the reply copy control would copy. */
export function lastReplyText(messages: readonly ChatMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (!message || message.role !== 'assistant' || message.status === 'pending') continue
		if (message.phase === 'commentary' || !message.text) continue
		return message.text
	}
	return undefined
}
