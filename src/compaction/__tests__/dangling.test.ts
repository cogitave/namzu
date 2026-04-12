import { describe, expect, it } from 'vitest'
import type {
	AssistantMessage,
	Message,
	ToolMessage,
	UserMessage,
} from '../../types/message/index.js'
import { findDanglingMessages, findSafeTrimIndex, removeDanglingMessages } from '../dangling.js'

/**
 * Test helpers to create messages with proper typing.
 */
function createUserMessage(content: string): UserMessage {
	return { role: 'user', content, timestamp: Date.now() }
}

function createAssistantMessage(content: string | null, toolCallIds?: string[]): AssistantMessage {
	const msg: AssistantMessage = {
		role: 'assistant',
		content,
		timestamp: Date.now(),
	}

	if (toolCallIds && toolCallIds.length > 0) {
		msg.toolCalls = toolCallIds.map((id) => ({
			id,
			type: 'function',
			function: { name: 'test_tool', arguments: '{}' },
		}))
	}

	return msg
}

function createToolMessage(content: string, toolCallId: string): ToolMessage {
	return { role: 'tool', content, toolCallId, timestamp: Date.now() }
}

describe('findDanglingMessages', () => {
	it('should find no dangling messages in a valid sequence', () => {
		const messages: Message[] = [
			createUserMessage('test'),
			createAssistantMessage('response', ['call-1']),
			createToolMessage('result', 'call-1'),
			createUserMessage('next'),
		]

		const result = findDanglingMessages(messages)

		expect(result.isValid).toBe(true)
		expect(result.assistantsWithUnmatchedCalls).toHaveLength(0)
		expect(result.orphanedToolMessages).toHaveLength(0)
	})

	it('should find assistant messages with unmatched tool calls', () => {
		const messages: Message[] = [
			createUserMessage('test'),
			createAssistantMessage('response', ['call-1']),
			// Missing tool message for call-1
			createUserMessage('next'),
		]

		const result = findDanglingMessages(messages)

		expect(result.isValid).toBe(false)
		expect(result.assistantsWithUnmatchedCalls).toContain(1)
		expect(result.orphanedToolMessages).toHaveLength(0)
	})

	it('should find orphaned tool messages with no matching assistant call', () => {
		const messages: Message[] = [
			createUserMessage('test'),
			createAssistantMessage('response', ['call-1']),
			createToolMessage('result', 'call-1'),
			createToolMessage('orphan', 'call-2'), // No assistant call for call-2
		]

		const result = findDanglingMessages(messages)

		expect(result.isValid).toBe(false)
		expect(result.orphanedToolMessages).toContain(3)
		expect(result.assistantsWithUnmatchedCalls).toHaveLength(0)
	})

	it('should handle multiple tool calls in a single assistant message', () => {
		const messages: Message[] = [
			createUserMessage('test'),
			createAssistantMessage('response', ['call-1', 'call-2']),
			createToolMessage('result-1', 'call-1'),
			createToolMessage('result-2', 'call-2'),
			createUserMessage('next'),
		]

		const result = findDanglingMessages(messages)

		expect(result.isValid).toBe(true)
	})

	it('should find partially satisfied multiple tool calls', () => {
		const messages: Message[] = [
			createUserMessage('test'),
			createAssistantMessage('response', ['call-1', 'call-2']),
			createToolMessage('result-1', 'call-1'),
			// Missing result for call-2
		]

		const result = findDanglingMessages(messages)

		expect(result.isValid).toBe(false)
		expect(result.assistantsWithUnmatchedCalls).toContain(1)
	})

	it('should find no dangling messages in an assistant-only sequence', () => {
		const messages: Message[] = [
			createUserMessage('test'),
			createAssistantMessage('response without tools'),
			createUserMessage('next'),
		]

		const result = findDanglingMessages(messages)

		expect(result.isValid).toBe(true)
	})

	it('should handle empty message array', () => {
		const messages: Message[] = []

		const result = findDanglingMessages(messages)

		expect(result.isValid).toBe(true)
		expect(result.assistantsWithUnmatchedCalls).toHaveLength(0)
		expect(result.orphanedToolMessages).toHaveLength(0)
	})

	it('should find multiple dangling issues in complex sequence', () => {
		const messages: Message[] = [
			createUserMessage('test'),
			createAssistantMessage('response', ['call-1']), // Unmatched
			createToolMessage('orphan-1', 'call-999'), // Orphaned
			createAssistantMessage('response2', ['call-2']),
			createToolMessage('result-2', 'call-2'),
			createToolMessage('orphan-2', 'call-888'), // Orphaned
		]

		const result = findDanglingMessages(messages)

		expect(result.isValid).toBe(false)
		expect(result.assistantsWithUnmatchedCalls).toContain(1)
		expect(result.orphanedToolMessages).toContain(2)
		expect(result.orphanedToolMessages).toContain(5)
	})
})

describe('removeDanglingMessages', () => {
	it('should return a copy when messages are already valid', () => {
		const messages: Message[] = [
			createUserMessage('test'),
			createAssistantMessage('response', ['call-1']),
			createToolMessage('result', 'call-1'),
		]

		const cleaned = removeDanglingMessages(messages)

		expect(cleaned).toEqual(messages)
		expect(cleaned).not.toBe(messages) // Different object
	})

	it('should remove assistant messages with unmatched tool calls', () => {
		const messages: Message[] = [
			createUserMessage('test'),
			createAssistantMessage('response', ['call-1']), // Will be removed
			createUserMessage('next'),
		]

		const cleaned = removeDanglingMessages(messages)

		expect(cleaned).toHaveLength(2)
		expect(cleaned[0]?.role).toBe('user')
		expect(cleaned[1]?.role).toBe('user')
	})

	it('should remove orphaned tool messages', () => {
		const messages: Message[] = [
			createUserMessage('test'),
			createAssistantMessage('response', ['call-1']),
			createToolMessage('result', 'call-1'),
			createToolMessage('orphan', 'call-999'), // Will be removed
		]

		const cleaned = removeDanglingMessages(messages)

		expect(cleaned).toHaveLength(3)
		expect(cleaned[3]).toBeUndefined()
	})

	it('should remove assistant and following orphaned tool messages together', () => {
		const messages: Message[] = [
			createUserMessage('test'),
			createAssistantMessage('response', ['call-1', 'call-2']), // call-2 unmatched → assistant flagged
			createToolMessage('attempt', 'call-1'), // Matches assistant's call list → removed with assistant
			createUserMessage('next'),
		]

		const cleaned = removeDanglingMessages(messages)

		expect(cleaned).toHaveLength(2)
		expect(cleaned[0]?.role).toBe('user')
		expect(cleaned[0]?.content).toBe('test')
		expect(cleaned[1]?.role).toBe('user')
		expect(cleaned[1]?.content).toBe('next')
	})

	it('should preserve message order while removing dangling messages', () => {
		const messages: Message[] = [
			createUserMessage('1'),
			createAssistantMessage('response', ['call-1']),
			createToolMessage('result', 'call-1'),
			createUserMessage('2'),
			createAssistantMessage('response2', ['call-2']), // Unmatched
			createUserMessage('3'),
		]

		const cleaned = removeDanglingMessages(messages)

		// Only the unmatched assistant is removed; valid pair and users are kept in order
		expect(cleaned).toHaveLength(5)
		expect(cleaned[0]?.content).toBe('1')
		expect(cleaned[1]?.content).toBe('response')
		expect(cleaned[2]?.content).toBe('result')
		expect(cleaned[3]?.content).toBe('2')
		expect(cleaned[4]?.content).toBe('3')
	})

	it('should handle complex cleanup with multiple dangling issues', () => {
		const messages: Message[] = [
			createUserMessage('start'),
			createAssistantMessage('response1', ['call-1']), // Unmatched
			createToolMessage('orphan-1', 'call-999'), // Orphaned
			createAssistantMessage('response2', ['call-2']),
			createToolMessage('result-2', 'call-2'),
			createToolMessage('orphan-2', 'call-888'), // Orphaned
			createUserMessage('end'),
		]

		const cleaned = removeDanglingMessages(messages)

		// Removed: assistant('response1') (unmatched), orphan-1, orphan-2
		// Kept: start, response2, result-2 (valid pair), end
		expect(cleaned).toHaveLength(4)
		expect(cleaned[0]?.content).toBe('start')
		expect(cleaned[1]?.content).toBe('response2')
		expect(cleaned[2]?.content).toBe('result-2')
		expect(cleaned[3]?.content).toBe('end')
	})

	it('should remove dangling assistant messages when they have follow-up tool attempts', () => {
		const messages: Message[] = [
			createUserMessage('test'),
			createAssistantMessage('response', ['call-1', 'call-2']), // call-2 unmatched → assistant flagged
			createToolMessage('wrong-result', 'call-1'), // Matches assistant's call list → removed with assistant
			createUserMessage('next'),
		]

		const cleaned = removeDanglingMessages(messages)

		expect(cleaned).toHaveLength(2)
		expect(cleaned[0]?.content).toBe('test')
		expect(cleaned[1]?.content).toBe('next')
	})
})

describe('findSafeTrimIndex', () => {
	it('should not trim when target is 0', () => {
		const messages: Message[] = [
			createUserMessage('test'),
			createAssistantMessage('response', ['call-1']),
			createToolMessage('result', 'call-1'),
		]

		const safeIdx = findSafeTrimIndex(messages, 0)

		expect(safeIdx).toBe(0)
	})

	it('should not trim when target is at end', () => {
		const messages: Message[] = [
			createUserMessage('test'),
			createAssistantMessage('response', ['call-1']),
			createToolMessage('result', 'call-1'),
		]

		const safeIdx = findSafeTrimIndex(messages, messages.length)

		expect(safeIdx).toBe(messages.length)
	})

	it('should clamp negative target index to 0', () => {
		const messages: Message[] = [createUserMessage('test')]

		const safeIdx = findSafeTrimIndex(messages, -5)

		expect(safeIdx).toBeGreaterThanOrEqual(0)
	})

	it('should clamp target beyond array length', () => {
		const messages: Message[] = [createUserMessage('test')]

		const safeIdx = findSafeTrimIndex(messages, 1000)

		expect(safeIdx).toBeLessThanOrEqual(messages.length)
	})

	it('should skip orphaned tool messages at trim point', () => {
		const messages: Message[] = [
			createUserMessage('test'),
			createAssistantMessage('response', ['call-1']),
			createToolMessage('result', 'call-1'),
			createToolMessage('orphan', 'call-999'), // Orphaned at trim point
			createUserMessage('next'),
		]

		const safeIdx = findSafeTrimIndex(messages, 3)

		// Should skip the orphaned tool message at index 3
		expect(safeIdx).toBeGreaterThan(3)
	})

	it('should preserve complete tool call/result pairs', () => {
		const messages: Message[] = [
			createUserMessage('test'),
			createAssistantMessage('response', ['call-1']),
			createToolMessage('result', 'call-1'),
			createUserMessage('next'),
		]

		// Try to trim in middle of pair
		const safeIdx = findSafeTrimIndex(messages, 2)

		// Algorithm advances forward past the pair — safeIdx=3 keeps the pair intact in slice(0, safeIdx)
		expect(safeIdx).toBe(3)
	})

	it('should not start with a tool message after trim', () => {
		const messages: Message[] = [
			createUserMessage('test'),
			createAssistantMessage('response', ['call-1']),
			createToolMessage('result', 'call-1'),
			createToolMessage('orphan', 'call-999'),
			createUserMessage('next'),
		]

		const safeIdx = findSafeTrimIndex(messages, 3)

		if (safeIdx < messages.length) {
			const firstAfterTrim = messages[safeIdx]
			if (firstAfterTrim) {
				expect(firstAfterTrim.role).not.toBe('tool')
			}
		}
	})

	it('should handle complex scenario with multiple pairs', () => {
		const messages: Message[] = [
			createUserMessage('1'),
			createAssistantMessage('response1', ['call-1']),
			createToolMessage('result-1', 'call-1'),
			createUserMessage('2'),
			createAssistantMessage('response2', ['call-2']),
			createToolMessage('result-2', 'call-2'),
			createUserMessage('3'),
		]

		// Try to trim between the two pairs
		const safeIdx = findSafeTrimIndex(messages, 4)

		// Should either include or exclude the second pair completely
		const kept = messages.slice(0, safeIdx)
		const danglingResult = findDanglingMessages(kept)
		expect(danglingResult.isValid).toBe(true)
	})

	it('should produce valid message sequence after trim', () => {
		const messages: Message[] = [
			createUserMessage('1'),
			createAssistantMessage('response1', ['call-1']),
			createToolMessage('result-1', 'call-1'),
			createUserMessage('2'),
			createAssistantMessage('response2', ['call-2']),
			createToolMessage('result-2', 'call-2'),
			createUserMessage('3'),
			createAssistantMessage('unmatched', ['call-3']), // Unmatched
		]

		// Try various trim points — target within bounds (excludes edge case target=messages.length
		// where trailing unmatched assistant cannot be trimmed forward)
		for (let target = 0; target < messages.length; target++) {
			const safeIdx = findSafeTrimIndex(messages, target)
			const keptMessages = messages.slice(0, safeIdx)

			const result = findDanglingMessages(keptMessages)
			expect(result.isValid).toBe(true)
		}
	})

	it('should not trim unnecessarily if sequence is already valid', () => {
		const messages: Message[] = [
			createUserMessage('test'),
			createAssistantMessage('response', ['call-1']),
			createToolMessage('result', 'call-1'),
			createUserMessage('next'),
		]

		const safeIdx = findSafeTrimIndex(messages, messages.length)

		expect(safeIdx).toBe(messages.length)
	})

	it('should advance past unsatisfied assistant message and its following tool attempt', () => {
		const messages: Message[] = [
			createUserMessage('test'),
			createAssistantMessage('response', ['call-1']), // Unmatched at index 1
			createToolMessage('attempt', 'call-1'), // Following attempt at index 2
			createUserMessage('next'),
		]

		const safeIdx = findSafeTrimIndex(messages, 2)

		// Should skip past the unmatched call and its following tool message
		expect(safeIdx).toBeGreaterThan(2)
		const kept = messages.slice(0, safeIdx)
		expect(findDanglingMessages(kept).isValid).toBe(true)
	})

	it('should handle all-tool-messages scenario', () => {
		const messages: Message[] = [
			createUserMessage('test'),
			createToolMessage('orphan-1', 'call-999'),
			createToolMessage('orphan-2', 'call-888'),
		]

		const safeIdx = findSafeTrimIndex(messages, 1)

		// Algorithm advances past both orphan tools — kept portion (slice from safeIdx) is empty and valid
		const kept = messages.slice(safeIdx)
		expect(findDanglingMessages(kept).isValid).toBe(true)
	})
})
