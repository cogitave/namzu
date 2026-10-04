import type { MessageId } from '../../types/ids/index.js'
import type { AssistantMessage, Message } from '../../types/message/index.js'

// Only the runtime that minted a stream's identity associates a freshly built
// assistant object here. Caller-authored BaseMessage.id is never an authority.
const identities = new WeakMap<Message, MessageId>()

export function withStreamedMessageIdentity(
	message: AssistantMessage,
	messageId: MessageId,
): AssistantMessage {
	identities.set(message, messageId)
	return message
}

/** Consume the trusted stream identity once, when this object is first recorded. */
export function takeStreamedMessageIdentity(message: Message): MessageId | undefined {
	const identity = identities.get(message)
	identities.delete(message)
	return identity
}
