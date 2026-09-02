import { describe, expect, it } from 'vitest'

import { CHARS_PER_TOKEN } from '../../../constants/limits.js'
import type { AssistantMessage, Message, ToolMessage } from '../../../types/message/index.js'
import { findDanglingMessages } from '../../dangling.js'
import { isClearedToolResult } from '../../tool-result-editing.js'
import { scoreMessages } from '../score.js'
import { isStubbedNarration, planWorkingSet } from '../working-set.js'

/**
 * The working set evicts the least salient tokens first and never changes
 * the conversation's shape: every message stays, every pair stays a pair.
 */

const big = (label: string, n = 3_000) => `${label}\n${'x '.repeat(n / 2)}`
const call = (id: string, name: string, args: unknown): AssistantMessage => ({
	role: 'assistant',
	content: null,
	toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
})
const result = (id: string, content: string): ToolMessage => ({
	role: 'tool',
	toolCallId: id,
	content,
})

function history(): Message[] {
	const messages: Message[] = [
		{ role: 'system', content: 'You are namzu.' },
		{ role: 'user', content: 'Fix slugify in src/slug.mjs so accents fold' },
	]
	for (let i = 0; i < 6; i += 1) {
		messages.push(
			call(`c${i}`, 'read', { path: `docs/page-${i}.md` }),
			result(`c${i}`, big(`docs/page-${i}.md contents`)),
		)
		messages.push({
			role: 'assistant',
			content: `I have looked at page ${i}. ${'This paragraph narrates what I intend to do next in some detail. '.repeat(6)}`,
		})
	}
	messages.push(
		call('cs', 'read', { path: 'src/slug.mjs' }),
		result('cs', big('src/slug.mjs: export function slugify(title) accents', 1_200)),
	)
	messages.push({ role: 'assistant', content: 'Now editing slugify in src/slug.mjs.' })
	return messages
}

const estimate = (messages: readonly Message[]) =>
	messages.reduce((n, m) => {
		const text = typeof m.content === 'string' ? m.content : ''
		return n + Math.ceil(text.length / CHARS_PER_TOKEN)
	}, 0)

describe('planWorkingSet', () => {
	it('clears the least salient results and stubs narration until the target is met, keeping the goal file', () => {
		const messages = history()
		const estimatedTokens = estimate(messages)
		const scored = scoreMessages(messages, {
			goal: 'Fix slugify in src/slug.mjs so accents fold',
			keepRecentMessages: 2,
		})
		const plan = planWorkingSet(messages, scored, {
			estimatedTokens,
			targetTokens: Math.floor(estimatedTokens * 0.4),
		})

		expect(plan.reachedTarget).toBe(true)
		expect(plan.clearedCount).toBeGreaterThan(0)
		expect(plan.stubbedCount).toBeGreaterThan(0)
		expect(plan.messages).toHaveLength(messages.length)
		// The read of the goal's own file was not the one to go.
		const slug = plan.messages.find(
			(m) => m.role === 'tool' && (m as ToolMessage).toolCallId === 'cs',
		) as ToolMessage
		expect(isClearedToolResult(slug.content)).toBe(false)
		// A stubbed narration keeps its first sentence.
		const stubbed = plan.messages.find(
			(m) => m.role === 'assistant' && isStubbedNarration(m.content),
		)
		expect(
			typeof stubbed?.content === 'string' && stubbed.content.startsWith('I have looked at page'),
		).toBe(true)
	})

	it('never splits a pair or removes a message', () => {
		const messages = history()
		const estimatedTokens = estimate(messages)
		const scored = scoreMessages(messages, { goal: 'anything', keepRecentMessages: 1 })
		const plan = planWorkingSet(messages, scored, { estimatedTokens, targetTokens: 1 })
		expect(plan.messages.map((m) => m.role)).toEqual(messages.map((m) => m.role))
		expect(findDanglingMessages(plan.messages).isValid).toBe(true)
	})

	it('will not evict what the goal names to shave the last tokens, and says it fell short', () => {
		const messages: Message[] = [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'Fix slugify in src/slug.mjs' },
			call('c1', 'read', { path: 'src/slug.mjs' }),
			result('c1', big('src/slug.mjs: export function slugify(title) accents', 4_000)),
			call('c2', 'read', { path: 'docs/a.md' }),
			result('c2', big('docs/a.md contents', 4_000)),
			call('c3', 'read', { path: 'docs/b.md' }),
			result('c3', big('docs/b.md contents', 4_000)),
			{ role: 'assistant', content: 'ok.' },
		]
		const estimatedTokens = estimate(messages)
		const scored = scoreMessages(messages, {
			goal: 'Fix slugify in src/slug.mjs',
			keepRecentMessages: 1,
		})
		// A target only the goal's own file could satisfy.
		const plan = planWorkingSet(messages, scored, { estimatedTokens, targetTokens: 100 })
		const slug = plan.messages.find(
			(m) => m.role === 'tool' && (m as ToolMessage).toolCallId === 'c1',
		) as ToolMessage
		expect(isClearedToolResult(slug.content)).toBe(false)
		expect(plan.clearedCount).toBe(2)
		expect(plan.reachedTarget).toBe(false)
	})

	it('leaves protected messages and small results alone, and says when it fell short', () => {
		const messages: Message[] = [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'keep this', retain: true },
			call('c1', 'read', { path: 'a' }),
			result('c1', 'small'),
			{ role: 'assistant', content: 'short note.' },
		]
		const scored = scoreMessages(messages, { goal: 'keep this', keepRecentMessages: 1 })
		const plan = planWorkingSet(messages, scored, { estimatedTokens: 10_000, targetTokens: 10 })
		expect(plan.actions).toEqual([])
		expect(plan.reachedTarget).toBe(false)
	})
})
