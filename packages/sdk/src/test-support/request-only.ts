import type { Message } from '../types/message/index.js'

/** True for a block that rides one request only (a runtime-context message of kind `step-context`). */
export function isRequestOnly(message: Message): boolean {
	return (
		message.role === 'user' &&
		message.source?.type === 'runtime-context' &&
		message.source.kind === 'step-context'
	)
}

/**
 * The part of a request that is history: every message but the request-only
 * blocks. Each request begins with the history of the one before it, whatever
 * the request-only blocks say.
 */
export function historyOf(messages: readonly Message[]): Message[] {
	return messages.filter((message) => !isRequestOnly(message))
}
