import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { applyEvent, emptyThread } from '../shared/projection.js'
import { ToolTranscriptRow } from './tool-transcript-row.js'

function row(durationMs: number | undefined, detailUnavailable = false): string {
	let thread = applyEvent(emptyThread(), { kind: 'prompt', sessionId: 's', prompt: 'Go' })
	thread = applyEvent(thread, {
		kind: 'update',
		sessionId: 's',
		projectId: 'p',
		update: {
			kind: 'tool_call',
			toolCallId: 'c',
			title: 'agent',
			status: 'completed',
			view: { kind: 'generic', label: 'Ran agent explore', presentation: 'activity' },
			...(durationMs === undefined ? {} : { durationMs }),
		},
	})
	if (detailUnavailable) thread.tools['1:c'] = { ...thread.tools['1:c']!, detailUnavailable: true }
	return renderToStaticMarkup(createElement(ToolTranscriptRow, { thread, id: '1:c' }))
}

it('never draws a duration beside a row; a second or more goes in the hover text', () => {
	const slow = row(6000)
	expect(slow).not.toContain('tool-duration')
	expect(slow).not.toContain(' ms')
	expect(slow).toContain('Took 6 s')
	const quick = row(11)
	expect(quick).not.toContain('tool-duration')
	expect(quick).not.toContain('Took')
})

it('does not open a row that has no saved details', () => {
	const html = row(undefined, true)
	expect(html).toContain('Details were not saved')
	expect(html).not.toContain('disclosure-chevron')
	expect(html).not.toContain('data-slot="collapsible-panel"')
})

it('puts the duration in the tooltip of a row that has one', () => {
	let thread = applyEvent(emptyThread(), { kind: 'prompt', sessionId: 's', prompt: 'Go' })
	thread = applyEvent(thread, {
		kind: 'update',
		sessionId: 's',
		projectId: 'p',
		update: {
			kind: 'tool_call',
			toolCallId: 'c',
			title: 'bash',
			status: 'completed',
			view: { kind: 'terminal', command: 'sleep 6', output: 'x' },
			durationMs: 6000,
		},
	})
	const html = renderToStaticMarkup(createElement(ToolTranscriptRow, { thread, id: '1:c' }))
	expect(html).toContain('Took 6 s')
})
