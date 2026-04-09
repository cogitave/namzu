import type { ConversationStore } from '../../types/conversation/index.js'
import type { MessageId, RunId, ThreadId } from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'
import { createAssistantMessage, createUserMessage } from '../../types/message/index.js'
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

export class InMemoryConversationStore implements ConversationStore {
	private readonly threads = new Map<ThreadId, ConversationMessage[]>()
	private readonly maxMessages: number

	constructor(config: InMemoryConversationStoreConfig = {}) {
		this.maxMessages = config.maxMessages ?? 100
	}

	loadMessages(threadId: ThreadId): Message[] {
		const messages = this.threads.get(threadId)
		if (!messages) return []

		const slice = messages.length > this.maxMessages ? messages.slice(-this.maxMessages) : messages

		return slice.map((m) => {
			switch (m.role) {
				case 'user':
					return createUserMessage(m.content)
				case 'assistant':
					return createAssistantMessage(m.content)
			}
		})
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
