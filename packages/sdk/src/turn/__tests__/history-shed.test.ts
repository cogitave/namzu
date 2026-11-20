import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '../../types/message/index.js'
import type { Message } from '../../types/message/index.js'
import { ANSWER_FROM_VISIBLE_HISTORY, historyContentShed } from '../history-shed.js'

describe('historyContentShed', () => {
	it('is false while every message is still in view', () => {
		const messages: Message[] = [
			createUserMessage('hi'),
			createAssistantMessage('hello'),
			{ role: 'tool', toolCallId: 'c', content: 'ordinary output' },
		]
		expect(historyContentShed(messages)).toBe(false)
	})

	it('is true once a compaction left a summary in place of messages', () => {
		expect(
			historyContentShed([
				{
					role: 'system',
					content: 'summary',
					source: { type: 'compaction-summary' },
				},
				createUserMessage('hi'),
			]),
		).toBe(true)
	})

	it('is true once a tool result was cleared', () => {
		expect(
			historyContentShed([{ role: 'tool', toolCallId: 'c', content: '[tool output cleared] x' }]),
		).toBe(true)
	})

	it('has one rule about history, worded the same everywhere it is used', () => {
		expect(ANSWER_FROM_VISIBLE_HISTORY).toBe(
			'If the answer is in your own earlier messages or tool results that are visible now, answer from them; do not search. Use the history tools only for something no longer visible (after compaction or a restart).',
		)
	})
})
