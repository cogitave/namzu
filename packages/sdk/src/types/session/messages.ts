/**
 * SessionMessage — the persistence record for a {@link Message} in the
 * session hierarchy.
 *
 * Rename of the legacy `ConversationMessage` concept, scoped by
 * {@link SessionId} and carrying {@link TenantId} for the Convention #17
 * key tuple (session-hierarchy.md §12.1). The `message` field preserves the
 * full Run-scoped `Message` payload verbatim; the wrapper only adds
 * addressability + tenant isolation.
 */

import type { MessageId, SessionId, TenantId } from '../ids/index.js'
import type { Message } from '../message/index.js'

export interface SessionMessage {
	readonly id: MessageId
	readonly sessionId: SessionId
	readonly tenantId: TenantId
	readonly message: Message
	readonly at: Date
}
