import type { RunId, ThreadId } from '../ids/index.js'
import type { Message } from '../message/index.js'

/**
 * @deprecated Use `SessionStore` from `@namzu/sdk` (import via
 * `types/session/store.ts` or the root barrel). `ConversationStore` is
 * thread-scoped and does not carry the `tenantId` required by
 * session-hierarchy.md §12.1. Scheduled for removal in 0.3.0; the one-
 * version migration window follows session-hierarchy.md §13.1.
 */
export interface ConversationStore {
	loadMessages(threadId: ThreadId): Message[]

	persistRunResult(threadId: ThreadId, runId: RunId, messages: Message[]): void
}
