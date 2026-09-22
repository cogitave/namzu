import { describe, expect, it } from 'vitest'

import type { Message } from '../../../types/message/index.js'
import { buildGoal } from '../goal.js'
import { scoreMessages } from '../score.js'

describe('the goal vector', () => {
	it('is the task, the live requirements, the open plan items and the latest intent', () => {
		const messages: Message[] = [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'Add a remove command to the todo CLI' },
			{ role: 'assistant', content: 'Reading the store first' },
			{ role: 'user', content: 'also make done fail on an unknown id' },
			{ role: 'assistant', content: 'Now editing src/store.mjs' },
		]
		const goal = buildGoal(messages, { openTasks: ['Document remove in README.md'] })
		expect(goal).toContain('Add a remove command')
		expect(goal).toContain('make done fail')
		expect(goal).toContain('Document remove in README.md')
		expect(goal).toContain('Now editing src/store.mjs')
		expect(goal).not.toContain('Reading the store first')
	})

	it('moves relevance when a new requirement arrives', () => {
		const base: Message[] = [
			{ role: 'user', content: 'Add a remove command' },
			{
				role: 'tool',
				toolCallId: 'a',
				content: 'README.md: a tiny todo list, documented commands',
			},
			{ role: 'tool', toolCallId: 'b', content: 'src/store.mjs: export function removeTodo' },
			{ role: 'assistant', content: 'ok' },
		]
		const before = scoreMessages(base, { goal: buildGoal(base), keepRecentMessages: 1 })
		const after: Message[] = [
			...base,
			{ role: 'user', content: 'and document every command in README.md' },
		]
		const scoredAfter = scoreMessages(after, { goal: buildGoal(after), keepRecentMessages: 1 })
		expect((before[1] as never as { relevance: number }).relevance).toBeLessThan(
			(scoredAfter[1] as never as { relevance: number }).relevance,
		)
	})
})
