import type { ThreadState } from '../shared/projection.js'
import type { ChatMessage } from '../shared/protocol.js'

export interface RetryableReply {
	/** The newest reply, which carries the Retry button. */
	reply: ChatMessage
	/** What the person asked, sent again as it was typed. */
	prompt: string
}

function lastIndexOf(messages: ChatMessage[], role: ChatMessage['role'], before: number): number {
	for (let index = Math.min(before, messages.length) - 1; index >= 0; index--)
		if (messages[index]?.role === role) return index
	return -1
}

/** A question that can be sent again: text only, since a file is not kept to send twice. */
function askedText(message: ChatMessage | undefined): string | undefined {
	if (!message || !message.text.trim() || message.attachments?.length) return undefined
	return message.text
}

/**
 * The newest reply when it can be asked again: nothing is running, and a person's text
 * question precedes it.
 */
export function retryableReply(thread: ThreadState): RetryableReply | undefined {
	if (thread.running || thread.retry || thread.retryNotice) return undefined
	const messages = thread.messages
	const replyAt = lastIndexOf(messages, 'assistant', messages.length)
	const reply = messages[replyAt]
	if (!reply || reply.phase === 'commentary' || !reply.text.trim()) return undefined
	const prompt = askedText(messages[lastIndexOf(messages, 'user', replyAt)])
	return prompt === undefined ? undefined : { reply, prompt }
}

/** What the person last asked, when no reply arrived because the turn failed. */
export function retryableAsk(thread: ThreadState): string | undefined {
	if (thread.running || thread.retry || thread.retryNotice || !thread.error) return undefined
	const messages = thread.messages
	return askedText(messages[lastIndexOf(messages, 'user', messages.length)])
}
