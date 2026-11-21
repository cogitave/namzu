import { createRuntimeContextMessage } from '../../types/message/index.js'
import type { Message } from '../../types/message/index.js'
import { isOperatorUserMessage } from './steering.js'

/** What the model reads between a request that was stopped before any reply and the next one. */
export const INTERRUPTED_REQUEST_MARKER = '[Request interrupted by user]'

/**
 * The provider-bound view of a conversation in which a request the person
 * stopped before it was answered says so.
 *
 * A turn stopped before the first reply leaves the person's message as the
 * last entry. The next message lands right behind it, so the model sees two
 * requests in a row and may answer the old one. The marker goes directly after
 * the unanswered message, where it happened. It is derived from the stored
 * history each time (never stored), so a resumed conversation carries the same
 * mark as the live one. An operator message that follows an assistant entry
 * never gets one, and neither does the message the model is answering now.
 * Returns the original array when nothing is marked.
 */
export function withInterruptedRequestsMarked(messages: Message[]): Message[] {
	let out: Message[] | undefined
	let pending = -1
	messages.forEach((message, index) => {
		if (message.role === 'assistant') {
			pending = -1
		} else if (isOperatorUserMessage(message)) {
			if (pending >= 0) {
				out ??= messages.slice(0, index)
				out.splice(
					pending + 1,
					0,
					createRuntimeContextMessage(INTERRUPTED_REQUEST_MARKER, 'step-context'),
				)
			}
			pending = out ? out.length : index
		}
		out?.push(message)
	})
	return out ?? messages
}
