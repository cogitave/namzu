/**
 * @deprecated Use `InMemorySessionStore` from
 * `@namzu/sdk/store/session`. This class implements the deprecated
 * `ConversationStore` contract (thread-scoped, no tenantId) and is kept
 * for one migration window per session-hierarchy.md §13.1; it will be
 * removed in 0.3.0.
 *
 * INTERPRETATION (Phase 3): the old class exposes helpers
 * (`addUserMessage`, `createThread`, `hasThread`, `deleteThread`,
 * `messageCount`, `clear`) that are not part of `ConversationStore` and
 * whose signatures rely on `ThreadId` + `Message` without `TenantId`.
 * Those signatures are structurally incompatible with the new
 * `SessionStore` surface, so a strict alias re-export would lose API
 * (roadmap §2 Phase 3 option (a)). We pick option (b) — retain the
 * original class body verbatim with a deprecation banner — to preserve
 * existing consumers during the migration window without polluting the
 * new `InMemorySessionStore` with thread-scoped helpers.
 */

import { findSafeTrimIndex } from '../../compaction/dangling.js'
import type { ConversationStore } from '../../types/conversation/index.js'
import type { MessageId, RunId, ThreadId } from '../../types/ids/index.js'
import {
	type Message,
	createAssistantMessage,
	createUserMessage,
} from '../../types/message/index.js'
import { extractFinalResponse } from '../../utils/conversation.js'
import { generateMessageId } from '../../utils/id.js'

interface ConversationMessage {
	readonly id: MessageId

	readonly threadId: ThreadId

	readonly role: 'user' | 'assistant'

	readonly content: string

	readonly runId?: RunId

	readonly createdAt: string
}

export interface InMemoryConversationStoreConfig {
	readonly maxMessages?: number
}

/**
 * @deprecated See module banner. Use `InMemorySessionStore` from
 * `@namzu/sdk/store/session`.
 */
export class InMemoryConversationStore implements ConversationStore {
	private readonly threads = new Map<ThreadId, ConversationMessage[]>()
	private readonly maxMessages: number

	constructor(config: InMemoryConversationStoreConfig = {}) {
		this.maxMessages = config.maxMessages ?? 100
	}

	loadMessages(threadId: ThreadId): Message[] {
		const messages = this.threads.get(threadId)
		if (!messages) return []

		// Convert to Message type for trim safety check
		const convertedMessages: Message[] = messages.map((m) => {
			switch (m.role) {
				case 'user':
					return createUserMessage(m.content)
				case 'assistant':
					return createAssistantMessage(m.content)
				default: {
					const _exhaustive: never = m.role
					throw new Error(`Unhandled message role: ${_exhaustive}`)
				}
			}
		})

		// Apply safe trimming to preserve tool call/result atomicity
		let trimStartIdx = 0
		if (convertedMessages.length > this.maxMessages) {
			const desiredTrimPoint = convertedMessages.length - this.maxMessages
			trimStartIdx = findSafeTrimIndex(convertedMessages, desiredTrimPoint)
		}

		return convertedMessages.slice(trimStartIdx)
	}

	persistRunResult(threadId: ThreadId, runId: RunId, messages: Message[]): void {
		const finalAssistant = extractFinalResponse(messages)
		if (!finalAssistant || !finalAssistant.content) return

		this.ensureThread(threadId)
		this.threads.get(threadId)?.push({
			id: generateMessageId(),
			threadId,
			role: 'assistant',
			content: finalAssistant.content,
			runId,
			createdAt: new Date().toISOString(),
		})
	}

	addUserMessage(threadId: ThreadId, content: string): MessageId {
		this.ensureThread(threadId)
		const id = generateMessageId()
		this.threads.get(threadId)?.push({
			id,
			threadId,
			role: 'user',
			content,
			createdAt: new Date().toISOString(),
		})
		return id
	}

	hasThread(threadId: ThreadId): boolean {
		return this.threads.has(threadId)
	}

	createThread(threadId: ThreadId): boolean {
		if (this.threads.has(threadId)) return false
		this.threads.set(threadId, [])
		return true
	}

	deleteThread(threadId: ThreadId): boolean {
		return this.threads.delete(threadId)
	}

	messageCount(threadId: ThreadId): number {
		return this.threads.get(threadId)?.length ?? 0
	}

	clear(): void {
		this.threads.clear()
	}

	private ensureThread(threadId: ThreadId): void {
		if (!this.threads.has(threadId)) {
			this.threads.set(threadId, [])
		}
	}
}
