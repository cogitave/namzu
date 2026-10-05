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

it('shows Pal plan milestones without treating failed or unmet dependencies as completed work', () => {
	const thread = {
		...emptyThread(),
		tasks: [
			{
				taskId: 'finished-private',
				subject: 'Build the scene',
				status: 'completed' as const,
				blockedBy: [],
			},
			{
				taskId: 'active-private',
				subject: 'Test the controls',
				status: 'in_progress' as const,
				blockedBy: ['finished-private'],
			},
			{
				taskId: 'failed-private',
				subject: 'Check the import',
				status: 'failed' as const,
				blockedBy: [],
			},
			{
				taskId: 'waiting-private',
				subject: 'Try the game',
				status: 'pending' as const,
				blockedBy: ['active-private'],
			},
			{
				taskId: 'retry-private',
				subject: 'Review the failed import',
				status: 'pending' as const,
				blockedBy: ['failed-private'],
			},
			{
				taskId: 'missing-private',
				subject: 'Find the reference',
				status: 'pending' as const,
				blockedBy: ['unknown-private'],
			},
		],
	}
	const html = renderToStaticMarkup(createElement(ConversationTasks, { thread, palName: 'Palu' }))
	expect(html).toContain('1 of 6 steps done')
	expect(html).toContain('1 needs attention')
	expect(html).toContain('Waiting on: Test the controls')
	expect(html).toContain('Earlier step: Check the import (needs attention)')
	expect(html).toContain('Waiting on: Unavailable step')
	expect(html).toContain('In progress')
	expect(html).toContain('Not started')
	expect(html).not.toContain('Waiting on: Build the scene')
	expect(html).not.toContain('Waiting on: Check the import')
	expect(html).not.toContain('private')
	expect(html).not.toContain('<progress')
	expect(html).not.toContain('%')
	const summary = renderToStaticMarkup(
		createElement(TasksProgress, { thread, palName: 'Palu', onOpen: () => {} }),
	)
	expect(summary).toContain('Progress · 1 of 6 steps done')
	expect(summary).toContain('1 needs attention')
})

it('collapses a finished Pal plan while retaining an accessible disclosure and a truthful count', () => {
	const thread = {
		...emptyThread(),
		tasks: [
			{
				taskId: 'private-done',
				subject: 'Finished plan step',
				status: 'completed' as const,
				blockedBy: [],
			},
		],
	}
	const html = renderToStaticMarkup(createElement(ConversationTasks, { thread, palName: 'Palu' }))
	expect(html).toContain('aria-label="Palu tasks"')
	expect(html).toContain('aria-label="View plan steps"')
	expect(html).toContain('aria-expanded="false"')
	expect(html).toContain('1 of 1 step done')
	expect(html).not.toContain('Finished plan step')
	expect(html).not.toContain('Completed')
	const unavailable = renderToStaticMarkup(
		createElement(ConversationTasks, {
			thread: { ...thread, tasksNotice: 'Task list unavailable.' },
			palName: 'Palu',
		}),
	)
	expect(unavailable).toContain('Finished plan step')
	expect(unavailable).toContain('Task list unavailable.')
})
