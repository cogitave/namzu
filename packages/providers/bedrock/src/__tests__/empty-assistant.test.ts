import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { toBedrockMessages } from '../client.js'

const call = (id: string) => ({
	id,
	type: 'function' as const,
	function: { name: 'web_fetch', arguments: '{"url":"https://example.test"}' },
})
const NOT_ALLOWED = 'web_fetch is not allowed in this session.'

describe('empty assistant history on the Converse wire', () => {
	it('sends no empty or "null" assistant turn and keeps every tool result after its call', () => {
		const messages: ChatCompletionParams['messages'] = [
			{ role: 'user', content: 'look it up' },
			{ role: 'assistant', content: null, toolCalls: [call('call-1'), call('call-2')] },
			{ role: 'tool', toolCallId: 'call-1', content: NOT_ALLOWED, isError: true },
			{ role: 'tool', toolCallId: 'call-2', content: NOT_ALLOWED, isError: true },
			{ role: 'assistant', content: null },
			{ role: 'assistant', content: '', toolCalls: [] },
			{ role: 'user', content: '[SYSTEM] Turn is ending.' },
		]
		const wire = toBedrockMessages(messages)
		// The two user turns around the dropped reply merge, as Converse needs.
		expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
		for (const turn of wire) {
			expect(turn.content?.length ?? 0).toBeGreaterThan(0)
			for (const block of turn.content ?? []) {
				expect((block as { text?: string }).text).not.toBe('')
				expect((block as { text?: string }).text).not.toBe('null')
			}
		}
		expect(
			wire[1]?.content?.map((b) => (b as { toolUse?: { toolUseId: string } }).toolUse?.toolUseId),
		).toEqual(['call-1', 'call-2'])
		const answered = wire[2]?.content?.flatMap((b) => {
			const result = (b as { toolResult?: { toolUseId: string } }).toolResult
			return result ? [result.toolUseId] : []
		})
		expect(answered).toEqual(['call-1', 'call-2'])
		// Outbound only: the stored history is not rewritten.
		expect(messages).toHaveLength(7)
	})

	it('keeps real text beside an empty tool_calls array', () => {
		const wire = toBedrockMessages([
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'hello', toolCalls: [] },
			{ role: 'user', content: 'again' },
		])
		expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
		expect(wire[1]?.content).toEqual([{ text: 'hello' }])
	})
})
