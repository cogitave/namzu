import { describe, expect, it } from 'vitest'

import type { Message } from '../../types/message/index.js'
import { clearStaleToolResults, isClearedToolResult } from '../tool-result-editing.js'

/**
 * Compaction was all-or-nothing: once the threshold hit, every older
 * message became a summary and the agent's own reasoning — the decisions,
 * the false starts it learned from, the exact wording of a plan — was
 * paraphrased away with it.
 *
 * That is a heavy price for a context problem usually caused by something
 * much dumber: a handful of enormous tool outputs the agent already read,
 * took what it needed from, and moved past.
 */

const big = (n: number) => 'x'.repeat(n)

function conversation(
	results: Array<{ tool: string; output: string; isError?: boolean }>,
): Message[] {
	const messages: Message[] = [{ role: 'system', content: 'you are an agent' }]
	results.forEach((r, i) => {
		messages.push({
			role: 'assistant',
			content: null,
			toolCalls: [
				{ id: `call_${i}`, type: 'function', function: { name: r.tool, arguments: '{}' } },
			],
		} as Message)
		messages.push({
			role: 'tool',
			content: r.output,
			toolCallId: `call_${i}`,
			...(r.isError ? { isError: true } : {}),
		} as Message)
	})
	return messages
}

describe('clearStaleToolResults', () => {
	it('clears an old, large result and leaves a placeholder naming the tool', () => {
		const messages = conversation([
			{ tool: 'read_file', output: big(50_000) },
			{ tool: 'ls', output: 'a.ts' },
			{ tool: 'ls', output: 'b.ts' },
			{ tool: 'ls', output: 'c.ts' },
		])

		const { messages: edited, clearedCount, charsReclaimed } = clearStaleToolResults(messages)

		expect(clearedCount).toBe(1)
		expect(charsReclaimed).toBeGreaterThan(49_000)
		const cleared = edited.find((m) => m.role === 'tool' && isClearedToolResult(m.content))
		expect(cleared?.content).toContain('read_file')
		expect(cleared?.content).toContain('50,000 characters')
	})

	it('keeps `tool_use` ↔ `tool_result` pairing intact — nothing moves', () => {
		// This is what makes clearing safe where trimming is not.
		const messages = conversation([
			{ tool: 'read_file', output: big(50_000) },
			{ tool: 'ls', output: 'a' },
			{ tool: 'ls', output: 'b' },
			{ tool: 'ls', output: 'c' },
		])

		const { messages: edited } = clearStaleToolResults(messages)

		expect(edited).toHaveLength(messages.length)
		edited.forEach((msg, i) => {
			expect(msg.role).toBe(messages[i]?.role)
			if (msg.role === 'tool') {
				expect(msg.toolCallId).toBe((messages[i] as { toolCallId: string }).toolCallId)
			}
		})
	})

	it('does not mutate the input', () => {
		const messages = conversation([
			{ tool: 'read_file', output: big(50_000) },
			{ tool: 'ls', output: 'a' },
			{ tool: 'ls', output: 'b' },
			{ tool: 'ls', output: 'c' },
		])
		const before = JSON.stringify(messages)
		clearStaleToolResults(messages)
		expect(JSON.stringify(messages)).toBe(before)
	})

	it('leaves the most recent results alone — the agent is still using them', () => {
		const messages = conversation([
			{ tool: 'a', output: big(20_000) },
			{ tool: 'b', output: big(20_000) },
			{ tool: 'c', output: big(20_000) },
			{ tool: 'd', output: big(20_000) },
		])

		const { clearedCount, messages: edited } = clearStaleToolResults(messages, {
			keepRecentToolResults: 3,
		})

		expect(clearedCount).toBe(1)
		// The last three are untouched.
		const toolMsgs = edited.filter((m) => m.role === 'tool')
		expect(toolMsgs.slice(1).every((m) => !isClearedToolResult(m.content))).toBe(true)
	})

	it('leaves small results alone — the placeholder would cost as much', () => {
		const messages = conversation([
			{ tool: 'ls', output: 'a.ts b.ts' },
			{ tool: 'ls', output: 'c.ts' },
			{ tool: 'ls', output: 'd.ts' },
			{ tool: 'ls', output: 'e.ts' },
		])
		expect(clearStaleToolResults(messages).clearedCount).toBe(0)
	})

	it('never clears an ERROR result — the error is what steers the next turn', () => {
		const messages = conversation([
			{ tool: 'bash', output: big(50_000), isError: true },
			{ tool: 'ls', output: 'a' },
			{ tool: 'ls', output: 'b' },
			{ tool: 'ls', output: 'c' },
		])
		expect(clearStaleToolResults(messages).clearedCount).toBe(0)
	})

	it('honors a preserve list, by tool name', () => {
		const messages = conversation([
			{ tool: 'load_spec', output: big(50_000) },
			{ tool: 'read_file', output: big(50_000) },
			{ tool: 'ls', output: 'a' },
			{ tool: 'ls', output: 'b' },
			{ tool: 'ls', output: 'c' },
		])

		const { clearedCount, messages: edited } = clearStaleToolResults(messages, {
			preserveTools: ['load_spec'],
		})

		expect(clearedCount).toBe(1)
		const specResult = edited.find((m) => m.role === 'tool' && m.toolCallId === 'call_0')
		expect(isClearedToolResult(specResult?.content)).toBe(false)
	})

	it('is idempotent — a second pass finds nothing left to do', () => {
		const messages = conversation([
			{ tool: 'read_file', output: big(50_000) },
			{ tool: 'ls', output: 'a' },
			{ tool: 'ls', output: 'b' },
			{ tool: 'ls', output: 'c' },
		])

		const first = clearStaleToolResults(messages)
		const second = clearStaleToolResults(first.messages)
		expect(second.clearedCount).toBe(0)
		expect(second.charsReclaimed).toBe(0)
	})

	it('reports the NET saving, not the gross one', () => {
		// A caller uses this number to decide "was that enough?", so
		// overstating it would send it back to summarize when it need not.
		const messages = conversation([
			{ tool: 'read_file', output: big(10_000) },
			{ tool: 'ls', output: 'a' },
			{ tool: 'ls', output: 'b' },
			{ tool: 'ls', output: 'c' },
		])

		const { messages: edited, charsReclaimed } = clearStaleToolResults(messages)
		const placeholder = edited.find((m) => m.role === 'tool' && isClearedToolResult(m.content))
		const placeholderLength = String(placeholder?.content).length

		expect(charsReclaimed).toBe(10_000 - placeholderLength)
	})

	it('measures an image result by its payload, which is the biggest win available', () => {
		// A screenshot is the single largest thing a tool result can carry,
		// and exactly the kind of output an agent reads once.
		const messages: Message[] = [
			{
				role: 'assistant',
				content: null,
				toolCalls: [
					{ id: 'call_s', type: 'function', function: { name: 'screenshot', arguments: '{}' } },
				],
			} as Message,
			{
				role: 'tool',
				content: [{ type: 'image', data: big(400_000), mediaType: 'image/png' }],
				toolCallId: 'call_s',
			} as Message,
		]

		const { clearedCount, charsReclaimed } = clearStaleToolResults(messages, {
			keepRecentToolResults: 0,
		})
		expect(clearedCount).toBe(1)
		expect(charsReclaimed).toBeGreaterThan(399_000)
	})

	it('does nothing to a conversation with no tool results', () => {
		const messages: Message[] = [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: 'hi' } as Message,
		]
		const out = clearStaleToolResults(messages)
		expect(out.clearedCount).toBe(0)
		expect(out.messages).toEqual(messages)
	})
})
