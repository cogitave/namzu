import { describe, expect, it } from 'vitest'

import type { Message } from '../../../types/message/index.js'
import { withoutVoidAssistantTurns } from '../request-void-turns.js'

const call = {
	id: 'c1',
	type: 'function' as const,
	function: { name: 'web_fetch', arguments: '{}' },
}

describe('withoutVoidAssistantTurns', () => {
	it('returns the same array when nothing is empty', () => {
		const messages: Message[] = [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'hello' },
		]
		expect(withoutVoidAssistantTurns(messages)).toBe(messages)
	})

	it.each([null, ''])('drops an assistant entry with content %j and nothing else', (content) => {
		const messages: Message[] = [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content },
			{ role: 'assistant', content, toolCalls: [], reasoning: [], citations: [] },
			{ role: 'user', content: 'again' },
		]
		const view = withoutVoidAssistantTurns(messages)
		expect(view).toEqual([messages[0], messages[3]])
		expect(messages).toHaveLength(4)
	})

	it('keeps an entry that holds reasoning, which a driver may need to replay', () => {
		const reasoning = [{ type: 'thinking' as const, text: 'hm', signature: 's' }]
		const messages: Message[] = [{ role: 'assistant', content: null, reasoning }]
		expect(withoutVoidAssistantTurns(messages)).toBe(messages)
	})

	it('keeps tool calls and every result after them', () => {
		const messages: Message[] = [
			{ role: 'assistant', content: null, toolCalls: [call] },
			{ role: 'tool', toolCallId: 'c1', content: 'not allowed', isError: true },
			{ role: 'assistant', content: null },
		]
		expect(withoutVoidAssistantTurns(messages)).toEqual(messages.slice(0, 2))
	})
})
