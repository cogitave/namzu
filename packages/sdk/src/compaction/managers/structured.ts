import type { CompactionConfig } from '../../config/runtime.js'
import type { Message } from '../../types/message/index.js'
import { findSafeTrimIndex } from '../dangling.js'
import {
	extractFromAssistantMessage,
	extractFromToolCall,
	extractFromUserMessage,
} from '../extractor.js'
import type { ConversationManager } from '../interface.js'
import { WorkingStateManager } from '../manager.js'
import { serializeState } from '../serializer.js'

/**
 * Structured conversation manager wrapping the existing WorkingStateManager.
 * Extracts context from messages into a structured state, then compacts via serialization.
 *
 * Flow:
 * 1. Extract state from input messages (tracks tasks, decisions, files, etc.)
 * 2. Serialize state to XML-like format
 * 3. Inject compacted state as system message
 * 4. Trim older messages, keeping the state message + recent history
 *
 * Provides maximum context preservation but more computational overhead.
 */
export class StructuredCompactionManager implements ConversationManager {
	readonly name = 'structured'
	private readonly config: CompactionConfig

	constructor(config: CompactionConfig) {
		this.config = config
	}

	applyManagement(messages: Message[]): Message[] {
		// Build working state from all messages
		const stateManager = new WorkingStateManager(this.config)

		let isFirstUserMessage = true
		for (const message of messages) {
			if (message.role === 'user') {
				extractFromUserMessage(stateManager, message.content, isFirstUserMessage)
				isFirstUserMessage = false
			} else if (message.role === 'assistant' && message.content) {
				extractFromAssistantMessage(stateManager, message.content, this.config)
			} else if (message.role === 'tool') {
				// Extract from tool messages if needed (optional refinement)
				// For now, we focus on assistant and user content
			} else if (message.role === 'assistant' && 'toolCalls' in message && message.toolCalls) {
				// Extract from tool calls
				for (const toolCall of message.toolCalls) {
					extractFromToolCall(stateManager, toolCall.function.name, toolCall.function.arguments)
				}
			}
		}

		// If not much context accumulated, don't inject state yet
		if (stateManager.slotCount() < this.config.richStateThreshold) {
			return messages
		}

		// Serialize state to string
		const state = stateManager.getState()
		const serialized = serializeState(state)

		// Inject as system message at the start (after first user message if present)
		const result: Message[] = []
		let injected = false

		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i]
			if (!msg) continue

			// Keep system messages and first user message
			result.push(msg)

			// Inject after first user message
			if (!injected && msg.role === 'user') {
				result.push({
					role: 'system',
					content: serialized,
					timestamp: Date.now(),
				})
				injected = true
			}
		}

		// If no user message found, inject at start
		if (!injected) {
			result.unshift({
				role: 'system',
				content: serialized,
				timestamp: Date.now(),
			})
		}

		// Trim old messages while keeping state message
		if (result.length > this.config.keepRecentMessages + 2) {
			const desiredTrimPoint = result.length - this.config.keepRecentMessages
			const safeTrimIdx = findSafeTrimIndex(result, desiredTrimPoint)

			// Always keep the injected system message
			const trimPoint = Math.min(
				safeTrimIdx,
				Math.max(0, result.length - this.config.keepRecentMessages),
			)
			return result.slice(trimPoint)
		}

		return result
	}

	reduceContext(messages: Message[], _overflowTokens: number): boolean {
		// Use the same approach as applyManagement but more aggressive trimming
		const stateManager = new WorkingStateManager(this.config)

		let isFirstUserMessage = true
		for (const message of messages) {
			if (message.role === 'user') {
				extractFromUserMessage(stateManager, message.content, isFirstUserMessage)
				isFirstUserMessage = false
			} else if (message.role === 'assistant' && message.content) {
				extractFromAssistantMessage(stateManager, message.content, this.config)
			} else if (message.role === 'assistant' && 'toolCalls' in message && message.toolCalls) {
				for (const toolCall of message.toolCalls) {
					extractFromToolCall(stateManager, toolCall.function.name, toolCall.function.arguments)
				}
			}
		}

		const state = stateManager.getState()
		const serialized = serializeState(state)

		// Build new messages: keep system messages, inject state, keep fewer recent messages
		const result: Message[] = []
		let injected = false

		for (const msg of messages) {
			if (msg.role === 'system') {
				result.push(msg)
			} else if (!injected && msg.role === 'user') {
				result.push(msg)
				result.push({
					role: 'system',
					content: serialized,
					timestamp: Date.now(),
				})
				injected = true
			}
		}

		// Add recent messages
		const recentCount = Math.max(1, Math.floor(this.config.keepRecentMessages * 0.5))
		const recentMessages = messages.filter((m) => m.role !== 'system').slice(-recentCount)

		for (const msg of recentMessages) {
			if (!result.includes(msg)) {
				result.push(msg)
			}
		}

		// Use safe trim to preserve tool atomicity
		if (result.length > recentCount + 2) {
			const desiredTrimPoint = result.length - recentCount
			const safeTrimIdx = findSafeTrimIndex(result, desiredTrimPoint)
			return safeTrimIdx > 0 && safeTrimIdx < result.length
		}

		return result.length < messages.length
	}
}
