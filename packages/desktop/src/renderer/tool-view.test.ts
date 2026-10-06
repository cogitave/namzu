import type { ToolCallView } from '@namzu/sdk'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { ToolTranscriptState } from './tool-transcript-presentation.js'
import { ToolView } from './tool-view.js'

function render(view: ToolCallView, state?: ToolTranscriptState): string {
	return renderToStaticMarkup(createElement(ToolView, { view, state }))
}

it.each([
	['waiting', 'Waiting for approval. No output yet.'],
	['running', 'No output yet.'],
	['completed', 'No output returned.'],
	['failed', 'No output was returned before the failure.'],
	['cancelled', 'No output was returned before cancellation.'],
	['interrupted', 'No output was returned before interruption.'],
] as const)('explains empty terminal output for %s without inventing a result', (state, text) => {
	const html = render({ kind: 'terminal', command: 'pwd', output: '' }, state)
	expect(html).toContain(`<pre>${text}</pre>`)
	expect(html).toContain('pwd')
})

it('preserves earlier callers and actual result text as escaped evidence regardless of outcome', () => {
	expect(render({ kind: 'terminal', output: '' })).toContain('<pre>No output.</pre>')
	for (const state of ['running', 'completed', 'failed', 'cancelled', 'interrupted'] as const) {
		const html = render({ kind: 'terminal', output: '<untrusted> actual output' }, state)
		expect(html).toContain('&lt;untrusted&gt; actual output')
		expect(html).not.toContain('<untrusted>')
		expect(html).not.toContain('No output')
	}
})

it('does not describe an unconfirmed edit as an applied After value', () => {
	const diff: ToolCallView = {
		kind: 'diff',
		path: 'note.txt',
		before: 'Before bytes',
		after: 'Proposed bytes',
	}
	for (const state of ['waiting', 'running', 'failed', 'cancelled', 'interrupted'] as const) {
		const html = render(diff, state)
		expect(html).toContain('<h4>Proposed change</h4>')
		expect(html).toContain('Before bytes')
		expect(html).toContain('Proposed bytes')
	}
	expect(render(diff, 'completed')).toContain('<h4>After</h4>')
	expect(render(diff)).toContain('<h4>After</h4>')
})
