import { describe, expect, it } from 'vitest'

import { type Message, createTurnContextEntry } from '../../types/message/index.js'
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
		expect(b.categories.find((c) => c.id === 'messages')?.tokens).toBe(157_000)
		expect(b.categories.find((c) => c.id === 'free')?.tokens).toBe(0)
		expect(b.overflowTokens).toBe(50_000)
	})

	it('leaves out categories with no tokens', () => {
		const b = analyzeContextUsage({ ...base, contextTokens: 5_000, systemPromptTokens: 1_000 })
		expect(b.categories.map((c) => c.id)).toEqual(['system-prompt', 'messages', 'buffer', 'free'])
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
			'buffer',
			'free',
		])
	})

	it('draws the buffer on a declared window too when auto-compact is on', () => {
		const b = analyzeContextUsage({ ...base, contextTokens: 1_000 })
		expect(b.bufferTokens).toBe(33_000)
		expect(b.categories.find((c) => c.id === 'buffer')).toMatchObject({ kind: 'buffer' })
		expect(b.categories.at(-1)).toMatchObject({ id: 'free', tokens: 200_000 - 1_000 - 33_000 })
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

describe('recorded context entries in the breakdown', () => {
	const entry = createTurnContextEntry('repository', 'x'.repeat(400))
	const messages: Message[] = [{ role: 'user', content: 'go' }, entry]

	it('are counted as memory, not as what the operator said', () => {
		const withEntry = analyzeContextUsage({ ...base, messages })
		const without = analyzeContextUsage({ ...base, messages: [messages[0] as Message] })
		expect(withEntry.messageBreakdown.userTokens).toBe(without.messageBreakdown.userTokens)
		const memory = withEntry.categories.find((c) => c.id === 'memory')?.tokens ?? 0
		expect(memory).toBeGreaterThan(100)
		// The conversation itself is the same size either way.
		expect(withEntry.categories.find((c) => c.id === 'messages')?.tokens).toBe(
			without.categories.find((c) => c.id === 'messages')?.tokens,
		)
	})

	it('are taken out of Messages when the size was measured', () => {
		const measured = analyzeContextUsage({ ...base, contextTokens: 10_000, messages })
		const tokens = (id: string) => measured.categories.find((c) => c.id === id)?.tokens ?? 0
		expect(tokens('memory') + tokens('messages')).toBe(10_000)
		expect(tokens('memory')).toBeGreaterThan(100)
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

	describe('a figure the kernel only estimated', () => {
		// The kernel's estimate is messages plus the tool catalogue. Everything
		// else is on top of it, not inside it.
		const estimate = {
			...base,
			measuredBy: 'estimate',
			systemPromptTokens: 10_000,
			systemToolTokens: 9_000,
			skillTokens: 2_000,
			memoryTokens: 1_000,
		} as const

		it('keeps Messages whole instead of subtracting parts the estimate never held', () => {
			// 5,000 of messages plus 9,000 of tool catalogue.
			const b = analyzeContextUsage({ ...estimate, contextTokens: 14_000 })
			expect(b.categories.find((c) => c.id === 'messages')?.tokens).toBe(5_000)
			expect(b.totalTokens).toBe(14_000 + 10_000 + 2_000 + 1_000)
		})

		it('used to understate Messages when read as a provider total', () => {
			const asProvider = analyzeContextUsage({
				...estimate,
				measuredBy: 'provider',
				contextTokens: 14_000,
			})
			expect(asProvider.categories.find((c) => c.id === 'messages')?.tokens ?? 0).toBe(0)
		})

		it('adds up: the rows are the total', () => {
			const b = analyzeContextUsage({ ...estimate, contextTokens: 14_000 })
			const used = b.categories.filter((c) => c.kind === 'used').reduce((n, c) => n + c.tokens, 0)
			expect(used).toBe(b.totalTokens)
		})

		it('leaves recorded context inside the estimate, under memory', () => {
			const entry = createTurnContextEntry('repository', 'r'.repeat(400))
			const b = analyzeContextUsage({
				...estimate,
				memoryTokens: 0,
				contextTokens: 14_000,
				messages: [entry],
			})
			const recorded = b.categories.find((c) => c.id === 'memory')?.tokens ?? 0
			expect(recorded).toBeGreaterThan(100)
			expect(b.categories.find((c) => c.id === 'messages')?.tokens).toBe(5_000 - recorded)
			expect(b.totalTokens).toBe(14_000 + 10_000 + 2_000)
		})

		it('reads an absent source as the provider counting everything', () => {
			const b = analyzeContextUsage({ ...base, systemPromptTokens: 1_000, contextTokens: 5_000 })
			expect(b.totalTokens).toBe(5_000)
			expect(b.categories.find((c) => c.id === 'messages')?.tokens).toBe(4_000)
		})
	})

	describe('tools that load only when needed', () => {
		it('sizes them as deferred and never counts them as used', () => {
			const without = analyzeContextUsage({
				...base,
				contextTokens: 10_000,
				systemToolTokens: 1_000,
			})
			const b = analyzeContextUsage({
				...base,
				contextTokens: 10_000,
				systemToolTokens: 1_000,
				deferredToolTokens: 25_300,
				deferredMcpToolTokens: 61_500,
			})
			expect(b.totalTokens).toBe(without.totalTokens)
			expect(b.percentage).toBe(without.percentage)
			expect(b.categories.find((c) => c.id === 'free')?.tokens).toBe(
				without.categories.find((c) => c.id === 'free')?.tokens,
			)
			expect(b.categories.filter((c) => c.kind === 'deferred')).toEqual([
				{ id: 'deferred-tools', name: 'System tools (deferred)', tokens: 25_300, kind: 'deferred' },
				{
					id: 'deferred-mcp-tools',
					name: 'MCP tools (deferred)',
					tokens: 61_500,
					kind: 'deferred',
				},
			])
		})

		it('lays them out after Messages and before the buffer', () => {
			const b = analyzeContextUsage({ ...base, contextTokens: 10_000, deferredToolTokens: 5 })
			expect(b.categories.map((c) => c.id)).toEqual([
				'messages',
				'deferred-tools',
				'buffer',
				'free',
			])
		})
	})
})
