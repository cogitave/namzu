import type { AcpSessionUpdate } from '@namzu/sdk'
import { type ComponentProps, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
import { PalActivity, palToolActivity } from './pal-activity.js'

// Materialize disclosed contents for receipt assertions; native checks exercise
// disclosure interaction and positioning with the actual Base UI component.
vi.mock('./ui/collapsible.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./ui/collapsible.js')>()
	return {
		...actual,
		CollapsiblePanel: ({ children }: ComponentProps<typeof actual.CollapsiblePanel>) =>
			createElement('div', {}, children),
	}
})

function update(thread: ThreadState, value: AcpSessionUpdate) {
	return applyEvent(thread, {
		kind: 'update',
		projectId: 'project',
		sessionId: 'session',
		update: value,
	})
}

function render(thread: ThreadState) {
	return renderToStaticMarkup(createElement(PalActivity, { thread }))
}

it('keeps exact admitted receipt order and presentation outside public chat', () => {
	let thread = applyEvent(emptyThread(), {
		kind: 'prompt',
		sessionId: 'session',
		prompt: 'Check it',
	})
	thread = update(thread, { kind: 'agent_thought_chunk', text: 'Private reasoning' })
	thread = update(thread, {
		kind: 'tool_call',
		toolCallId: 'first',
		title: 'Read workspace',
		status: 'completed',
		view: { kind: 'terminal', command: 'pwd', output: '/guest/workspace' },
	})
	thread = update(thread, {
		kind: 'tool_call',
		toolCallId: 'second',
		title: 'Update file',
		status: 'completed',
		view: {
			kind: 'diff',
			path: '/guest/workspace/test.txt',
			before: 'before text',
			after: 'after text',
		},
	})
	thread = update(thread, {
		kind: 'tool_call',
		toolCallId: 'first',
		title: 'Read workspace',
		status: 'completed',
		view: { kind: 'terminal', command: 'pwd', output: '/guest/workspace/current' },
	})
	const before = structuredClone(thread)
	const rows = palToolActivity(thread)
	for (const row of rows) expect(row.tool).toBe(thread.tools[row.id])
	expect(rows.map(({ tool }) => tool.toolCallId)).toEqual(['first', 'second'])
	const html = render(thread)
	expect(html.indexOf('Read workspace')).toBeLessThan(html.indexOf('Update file'))
	for (const exact of [
		'/guest/workspace/current',
		'pwd',
		'/guest/workspace/test.txt',
		'before text',
		'after text',
	])
		expect(html).toContain(exact)
	expect(html).not.toContain('Private reasoning')
	expect(html).not.toContain('Check it')
	expect(thread).toEqual(before)
})

it('reports actual pending, interrupted and failed action states without claiming completion', () => {
	const thread = update(
		applyEvent(emptyThread(), { kind: 'state', sessionId: 'session', running: true, queued: [] }),
		{
			kind: 'tool_call',
			toolCallId: 'pending',
			title: 'Pending action',
			status: 'pending',
			view: { kind: 'generic', label: 'Exact presentation' },
		},
	)
	expect(render(thread)).toContain('Working')
	const interrupted = { ...thread, activeToolIds: [] }
	expect(render(interrupted)).toContain('Interrupted')
	expect(render(interrupted)).not.toContain('Completed')
	const failed = update(thread, {
		kind: 'tool_call',
		toolCallId: 'pending',
		title: 'Failed action',
		status: 'failed',
		view: { kind: 'terminal', command: 'run', output: 'Actual failure output' },
	})
	expect(render(failed)).toContain('Failed')
	expect(render(failed)).toContain('Actual failure output')
	expect(render(failed)).not.toContain('Completed')
})

it('renders an honest empty activity state without inference or tools', () => {
	const thread = emptyThread()
	expect(palToolActivity(thread)).toEqual([])
	const html = render(thread)
	expect(html).toContain('aria-label="Pal actions"')
	expect(html).toContain('No retained actions in this view.')
	expect(html).not.toContain('data-tool-call-id')
})
