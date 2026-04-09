import type { RunId, ThreadId } from '../ids/index.js'
import type { Message } from '../message/index.js'

export interface ConversationStore {
	loadMessages(threadId: ThreadId): Message[]

	persistRunResult(threadId: ThreadId, runId: RunId, messages: Message[]): void
}
