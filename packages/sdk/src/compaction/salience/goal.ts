/**
 * The goal vector: what "relevant" is measured against.
 *
 * Not the whole history — that would make every message relevant to
 * itself — but the four things that say what the run is for right now:
 * the first user message (the task), the most recent user turns (the
 * requirements as they were refined), the open items of the task list
 * when the run keeps one, and the latest assistant text (its stated
 * intent). Weighted by repetition rather than a coefficient: the task
 * statement is included twice so a run that has drifted into detail is
 * still scored against what it was asked to do.
 */

import type { Message } from '../../types/message/index.js'

export interface GoalSources {
	/** Titles of task-list items not yet completed, when the host keeps a task store. */
	readonly openTasks?: readonly string[]
	/** How many of the latest user turns count as live requirements. */
	readonly recentUserTurns?: number
}

export function buildGoal(messages: readonly Message[], sources: GoalSources = {}): string {
	const users = messages.filter(
		(m): m is Extract<Message, { role: 'user' }> =>
			m.role === 'user' && typeof m.content === 'string',
	)
	const first = users[0]?.content ?? ''
	const recent = users
		.slice(-(sources.recentUserTurns ?? 3))
		.map((m) => m.content)
		.filter((text) => text !== first)
	let latestIntent = ''
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i] as Message
		if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 0) {
			latestIntent = m.content
			break
		}
	}
	return [first, first, ...recent, ...(sources.openTasks ?? []), latestIntent]
		.filter((part) => part.length > 0)
		.join('\n')
}
