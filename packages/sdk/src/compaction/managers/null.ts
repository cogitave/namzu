import type { Message } from '../../types/message/index.js'
import type { ConversationManager } from '../interface.js'

/**
 * No-op conversation manager implementation.
 * Never modifies messages, useful for testing or when context management is disabled.
 */
export class NullManager implements ConversationManager {
	readonly name = 'null'

	applyManagement(messages: Message[]): Message[] {
		return messages
	}

	reduceContext(_messages: Message[], _overflowTokens: number): boolean {
		// Cannot reduce; no operations performed
		return false
	}
}
