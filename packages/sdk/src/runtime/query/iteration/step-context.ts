import { createRuntimeContextMessage } from '../../../types/message/index.js'
import type { Message } from '../../../types/message/index.js'
import { isOperatorUserMessage } from '../steering.js'

/**
 * Request-only context, as the model reads it: a runtime-context user
 * message of kind `step-context`, labelled so the model does not take it
 * for something the operator just said.
 *
 * Its own module because two sides of an import cycle need it: the
 * working-memory phase, which `step-shaping` reaches through the compaction
 * phase, and `step-shaping` itself.
 */
export function stepContextMessage(content: string) {
	return createRuntimeContextMessage(
		`Current step context (runtime-generated; not a new user request):\n${content}`,
		'step-context',
	)
}

/**
 * Put `blocks` in front of the operator's new message when that message is
 * what the model is about to answer, so the request is the last thing it
 * reads and the longest data comes before it. Only the reminders and other
 * request-only context may follow that message: once the turn has an
 * assistant or tool message after it, the blocks stay at the end of the
 * history, where a caching driver ends its breakpoint before them, so the
 * tool loop of a long turn is not re-read at full price on every step.
 *
 * Reminders and notices that follow the operator's message stay where they
 * are: they are short, and the edge after the request is where they are read.
 */
export function placeBeforeLatestOperatorMessage(history: Message[], blocks: readonly Message[]) {
	if (blocks.length === 0) return
	let at = history.length
	for (let i = history.length - 1; i >= 0; i--) {
		const message = history[i] as Message
		if (isOperatorUserMessage(message)) {
			at = i
			break
		}
		// A reply or a tool result after the message: the model has moved on.
		if (message.role === 'assistant' || message.role === 'tool') break
	}
	history.splice(at, 0, ...blocks)
}
