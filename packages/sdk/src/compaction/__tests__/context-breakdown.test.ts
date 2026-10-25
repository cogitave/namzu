import { describe, expect, it } from 'vitest'

import type { Message } from '../../types/message/index.js'
import { analyzeContextUsage, describeToolCatalogTokens } from '../context-breakdown.js'
import { estimateTextTokens } from '../token-estimate.js'

const base = { windowTokens: 200_000, windowSource: 'auto', autoCompact: true } as const

const sum = (b: ReturnType<typeof analyzeContextUsage>) =>
	b.categories.filter((c) => c.kind !== 'free').reduce((n, c) => n + c.tokens, 0)

describe('analyzeContextUsage', () => {
	it('adds up to the window with free space', () => {
		const b = analyzeContextUsage({
			...base,
			contextTokens: 42_000,
			systemPromptTokens: 3_000,
			systemToolTokens: 9_000,
			memoryTokens: 1_000,
		})
		const total = b.categories.reduce((n, c) => n + c.tokens, 0)
		expect(total).toBe(200_000)
		expect(b.totalTokens).toBe(42_000)
		expect(b.percentage).toBe(21)
	})

	it('derives Messages from the measured size minus the fixed parts', () => {
		const b = analyzeContextUsage({
			...base,
			contextTokens: 42_000,
			systemPromptTokens: 3_000,
			systemToolTokens: 9_000,
		})
		expect(b.categories.find((c) => c.id === 'messages')?.tokens).toBe(30_000)
	})

	it('clamps Messages to the room left and reports the overflow', () => {
		const b = analyzeContextUsage({ ...base, contextTokens: 250_000, systemPromptTokens: 10_000 })
		expect(b.categories.find((c) => c.id === 'messages')?.tokens).toBe(190_000)
		expect(b.categories.find((c) => c.id === 'free')?.tokens).toBe(0)
		expect(b.overflowTokens).toBe(50_000)
	})

	it('leaves out categories with no tokens', () => {
		const b = analyzeContextUsage({ ...base, contextTokens: 5_000, systemPromptTokens: 1_000 })
		expect(b.categories.map((c) => c.id)).toEqual(['system-prompt', 'messages', 'free'])
	})

	it('keeps the layout order', () => {
		const b = analyzeContextUsage({
			...base,
			contextTokens: 50_000,
			skillTokens: 100,
			agentTokens: 100,
			mcpToolTokens: 100,
			systemToolTokens: 100,
			systemPromptTokens: 100,
			memoryTokens: 100,
			mcpInstructionTokens: 100,
		})
		expect(b.categories.map((c) => c.id)).toEqual([
			'system-prompt',
			'system-tools',
			'mcp-tools',
			'mcp-instructions',
			'agents',
			'memory',
			'skills',
			'messages',
			'free',
		])
	})

	it('has no buffer on a declared window with auto-compact on', () => {
		const b = analyzeContextUsage({ ...base, contextTokens: 1_000 })
		expect(b.bufferTokens).toBe(0)
		expect(b.categories.some((c) => c.id === 'buffer')).toBe(false)
	})

	it('draws the buffer on an overridden window: output cap (at most 20k) plus 13k', () => {
		const a = analyzeContextUsage({ ...base, windowSource: 'config', contextTokens: 1_000 })
		expect(a.bufferTokens).toBe(33_000)
		expect(a.categories.at(-2)).toMatchObject({
			id: 'buffer',
			name: 'Autocompact buffer',
			kind: 'buffer',
		})
		const b = analyzeContextUsage({
			...base,
			windowSource: 'default',
			maxOutputTokens: 8_000,
			contextTokens: 1_000,
		})
		expect(b.bufferTokens).toBe(21_000)
		expect(sum(b) + (b.categories.at(-1)?.tokens ?? 0)).toBe(200_000)
	})

	it('keeps a 3,000 token compact buffer when auto-compact is off', () => {
		const b = analyzeContextUsage({ ...base, autoCompact: false, contextTokens: 1_000 })
		expect(b.categories.find((c) => c.id === 'buffer')).toMatchObject({
			name: 'Compact buffer',
			tokens: 3_000,
			kind: 'buffer',
		})
		expect(b.autoCompact).toBe(false)
	})

	it('estimates the conversation without a measurement', () => {
		const messages: Message[] = [{ role: 'user', content: 'x'.repeat(400) }]
		const b = analyzeContextUsage({ ...base, messages })
		expect(b.categories.find((c) => c.id === 'messages')?.tokens).toBe(100)
	})

	it('attributes a result to the tool whose call id it answers', () => {
		const messages: Message[] = [
			{ role: 'user', content: 'go' },
			{
				role: 'assistant',
				content: null,
				toolCalls: [
					{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
					{ id: 'c2', type: 'function', function: { name: 'bash', arguments: '{}' } },
				],
			},
			{ role: 'tool', toolCallId: 'c2', content: 'y'.repeat(800) },
			{ role: 'tool', toolCallId: 'c1', content: 'z'.repeat(40) },
		]
		const { messageBreakdown } = analyzeContextUsage({ ...base, messages })
		expect(messageBreakdown.toolResultsByType).toEqual({ bash: 200, read: 10 })
		expect(messageBreakdown.toolCallsByType.read).toBe(estimateTextTokens('read{"path":"a"}'))
		expect(messageBreakdown.userTokens).toBe(1)
	})
})

describe('describeToolCatalogTokens', () => {
	it('sizes each tool by its rendered length', () => {
		const tool = (name: string, description: string) => ({
			type: 'function' as const,
			function: { name, description, parameters: {} },
		})
		const out = describeToolCatalogTokens([tool('a', ''), tool('b', 'x'.repeat(400))])
		expect(out.map((t) => t.name)).toEqual(['a', 'b'])
		expect(out[1]?.tokens).toBeGreaterThan((out[0]?.tokens ?? 0) + 99)
	})
})
