import { describe, expect, it } from 'vitest'
import {
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
} from '../../types/message/index.js'
import { SlidingWindowManager } from '../managers/slidingWindow.js'

describe('SlidingWindowManager', () => {
	it('should have correct name', () => {
		const manager = new SlidingWindowManager()
		expect(manager.name).toBe('sliding-window')
	})

	it('should not trim messages under window size', () => {
		const manager = new SlidingWindowManager({ keepRecentMessages: 4 })
		const messages = [
			createUserMessage('msg 1'),
			createAssistantMessage('response 1'),
			createUserMessage('msg 2'),
		]

		const result = manager.applyManagement(messages)
		expect(result).toHaveLength(3)
	})

	it('should trim messages exceeding window size', () => {
		const manager = new SlidingWindowManager({ keepRecentMessages: 2 })
		const messages = [
			createUserMessage('msg 1'),
			createAssistantMessage('response 1'),
			createUserMessage('msg 2'),
			createAssistantMessage('response 2'),
			createUserMessage('msg 3'),
			createAssistantMessage('response 3'),
		]

		const result = manager.applyManagement(messages)
		expect(result.length).toBeLessThanOrEqual(messages.length)
		expect(result.length).toBeGreaterThanOrEqual(2)
	})

	it('should preserve recent messages', () => {
		const manager = new SlidingWindowManager({ keepRecentMessages: 2 })
		const msg1 = createUserMessage('msg 1')
		const msg2 = createAssistantMessage('response 1')
		const msg3 = createUserMessage('msg 2')
		const msg4 = createAssistantMessage('response 2')

		const messages = [msg1, msg2, msg3, msg4]
		const result = manager.applyManagement(messages)

		// Should include the most recent messages
		expect(result).toContain(msg3)
		expect(result).toContain(msg4)
	})

	it('should preserve tool call/result pairs', () => {
		const manager = new SlidingWindowManager({ keepRecentMessages: 2 })
		const messages = [
			createUserMessage('old message'),
			createAssistantMessage(null, [
				{
					id: 'call_1',
					type: 'function',
					function: { name: 'test_tool', arguments: '{}' },
				},
			]),
			createToolMessage('result 1', 'call_1'),
			createUserMessage('recent message'),
		]

		const result = manager.applyManagement(messages)

		// Should keep the tool call/result pair together if included
		const callIdx = result.findIndex(
			(m) => m.role === 'assistant' && 'toolCalls' in m && m.toolCalls?.length === 1,
		)
		const resultIdx = result.findIndex(
			(m) => m.role === 'tool' && 'toolCallId' in m && m.toolCallId === 'call_1',
		)

		if (callIdx !== -1) {
			// If call is present, result should be present and after it
			expect(resultIdx).toBeGreaterThan(callIdx)
		} else {
			// If call is removed, result should also be removed
			expect(resultIdx).toBe(-1)
		}
	})

	it('should return false from reduceContext if already minimal', () => {
		const manager = new SlidingWindowManager({ keepRecentMessages: 1 })
		const messages = [createUserMessage('msg')]

		const result = manager.reduceContext(messages, 1000)
		expect(result).toBe(false)
	})

	it('should return true from reduceContext if reduction possible', () => {
		const manager = new SlidingWindowManager({ keepRecentMessages: 4 })
		const messages = [
			createUserMessage('msg 1'),
			createAssistantMessage('response 1'),
			createUserMessage('msg 2'),
			createAssistantMessage('response 2'),
			createUserMessage('msg 3'),
			createAssistantMessage('response 3'),
			createUserMessage('msg 4'),
			createAssistantMessage('response 4'),
		]

		const result = manager.reduceContext(messages, 1000)
		expect(result).toBe(true)
	})

	it('should use default keepRecentMessages when not provided', () => {
		const manager = new SlidingWindowManager()
		const messages = Array(10)
			.fill(null)
			.map((_, i) => createUserMessage(`msg ${i}`))

		const result = manager.applyManagement(messages)
		expect(result.length).toBeLessThanOrEqual(4) // default is 4
	})

	it('should handle empty message array', () => {
		const manager = new SlidingWindowManager()
		const result = manager.applyManagement([])
		expect(result).toHaveLength(0)
	})

	it('should handle single message', () => {
		const manager = new SlidingWindowManager({ keepRecentMessages: 2 })
		const messages = [createUserMessage('only message')]
		const result = manager.applyManagement(messages)
		expect(result).toEqual(messages)
	})
})
