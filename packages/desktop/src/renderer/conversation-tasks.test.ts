import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { emptyThread } from '../shared/projection.js'
import { ConversationTasks, TasksProgress } from './conversation-tasks.js'

it('shows the real plan and failure separately from completed work and resolves dependencies without raw IDs', () => {
	const thread = {
		...emptyThread(),
		tasks: [
			{
				taskId: 'private-id-first',
				subject: 'Make asset',
				status: 'completed' as const,
				blockedBy: [],
			},
			{
				taskId: 'private-id-second',
				subject: '<Verify game>',
				status: 'failed' as const,
				blockedBy: ['private-id-first', 'private-missing'],
				owner: 'private-agent-id',
			},
			{
				taskId: 'private-id-third',
				subject: 'Retry import',
				status: 'in_progress' as const,
				blockedBy: [],
			},
		],
	}
	const html = renderToStaticMarkup(createElement(ConversationTasks, { thread }))
	for (const text of [
		'Make asset',
		'&lt;Verify game&gt;',
		'Failed',
		'In progress',
		'Depends on: Make asset, Unavailable task',
	])
		expect(html).toContain(text)
	for (const text of ['private-id', 'private-agent-id', 'private-missing', 'verified'])
		expect(html).not.toContain(text)
	const progress = renderToStaticMarkup(
		createElement(TasksProgress, { thread, onOpen: () => undefined }),
	)
	expect(progress).toContain('1/3 completed')
	expect(progress).toContain('1 failed')
})
it('does not create an empty plan and marks failed reads as unavailable while retaining known states', () => {
	expect(renderToStaticMarkup(createElement(ConversationTasks, { thread: emptyThread() }))).toBe('')
	const thread = { ...emptyThread(), tasksNotice: 'Task list unavailable.' }
	expect(renderToStaticMarkup(createElement(ConversationTasks, { thread }))).toContain(
		'Task list unavailable.',
	)
	expect(
		renderToStaticMarkup(createElement(TasksProgress, { thread, onOpen: () => undefined })),
	).toContain('Unavailable')
})
