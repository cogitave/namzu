import { describe, expect, it } from 'vitest'
import { selectAssistantText } from '../types/message/index.js'
import { collectChatCompletion } from './collect-chat-completion.js'
import { StreamTextAccumulator } from './stream-text.js'

const parts = [
	{ id: 'progress', phase: 'commentary' as const, text: 'Which record?' },
	{ id: 'answer', phase: 'final_answer' as const, text: 'Which record?' },
] as const

describe('assistant text phases', () => {
	it('selects final items without deduplicating repeated words inside an answer', () => {
		expect(selectAssistantText(parts)).toBe('Which record?')
		expect(selectAssistantText([{ ...parts[1], text: 'ha ha' }])).toBe('ha ha')
		expect(selectAssistantText([parts[1], { ...parts[1], id: 'second' }])).toBe(
			'Which record?\n\nWhich record?',
		)
	})
	it('keeps the unphased stream behavior exactly', () => {
		const text = new StreamTextAccumulator()
		for (const content of ['a', 'b', 'b']) text.push({ id: 'r', delta: { content } })
		expect(text.text).toBe('abb')
		expect(text.textParts).toBeUndefined()
	})
	it('retains commentary and selects a streamed final answer before settlement', () => {
		const text = new StreamTextAccumulator()
		for (const part of parts)
			text.push({
				id: 'r',
				delta: { content: part.text, textPart: { id: part.id, phase: part.phase } },
			})
		expect(text.text).toBe('Which record?')
		expect(text.textParts).toEqual(parts)
		expect(text.characters).toBeGreaterThan(text.text.length)
	})
	it('uses a final snapshot once, including late phase metadata', async () => {
		const result = await collectChatCompletion(
			(async function* () {
				yield { id: 'r', delta: { content: 'Which record?Which record?' } }
				yield { id: 'r', delta: {}, textParts: parts }
			})(),
		)
		expect(result.message.content).toBe('Which record?')
		expect(result.message.textParts).toEqual(parts)
	})
	it('keeps a commentary-only response without declaring a final-answer phase', () => {
		const text = new StreamTextAccumulator()
		text.push({ id: 'r', delta: {}, textParts: [parts[0]] })
		expect(text.text).toBe('Which record?')
		expect(text.textParts?.[0]?.phase).toBe('commentary')
	})
	it('does not accept more content after a completed snapshot', () => {
		const text = new StreamTextAccumulator()
		text.push({ id: 'r', delta: {}, textParts: parts })
		expect(() => text.push({ id: 'r', delta: { content: 'late' } })).toThrow('after the completed')
	})
})
