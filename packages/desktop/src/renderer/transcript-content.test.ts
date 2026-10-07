import type { AcpSessionUpdate } from '@namzu/sdk'
import { type ComponentProps, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { type ThreadState, applyEvent, emptyThread, restoreMessages } from '../shared/projection.js'
import { PalActivity } from './pal-activity.js'
import { Transcript } from './transcript.js'

// Inspect all admitted bodies here; the browser proof exercises real disclosures.
vi.mock('./ui/collapsible.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./ui/collapsible.js')>()
	return {
		...actual,
		CollapsiblePanel: ({ children }: ComponentProps<typeof actual.CollapsiblePanel>) =>
			createElement('div', {}, children),
	}
})

function started() {
	return applyEvent(
		applyEvent(emptyThread(), { kind: 'prompt', sessionId: 's', prompt: 'Check the project' }),
		{ kind: 'state', sessionId: 's', running: true, queued: [] },
	)
}
function update(thread: ThreadState, value: AcpSessionUpdate) {
	return applyEvent(thread, { kind: 'update', sessionId: 's', projectId: 'p', update: value })
}
function render(thread: ThreadState) {
	return renderToStaticMarkup(createElement(Transcript, { thread }))
}

describe('public transcript content', () => {
	it('distinguishes an update, admitted reasoning, tool output and the final answer in actual order', () => {
		let thread = update(started(), {
			kind: 'agent_message',
			status: 'completed',
			messageId: 'update',
			textParts: [{ id: 'update-part', phase: 'commentary', text: 'Checking the saved settings.' }],
			content: 'Checking the saved settings.',
			stopReason: 'end_turn',
		})
		thread = update(thread, {
			kind: 'agent_thought_chunk',
			text: 'Compare the two recorded values.',
		})
		thread = update(thread, {
			kind: 'tool_call',
			toolCallId: 'read',
			title: 'Read settings',
			status: 'completed',
			view: { kind: 'terminal', output: 'Actual settings content' },
		})
		thread = update(thread, {
			kind: 'agent_message',
			status: 'completed',
			messageId: 'final',
			textParts: [{ id: 'final-part', phase: 'final_answer', text: 'The settings match.' }],
			content: 'The settings match.',
			stopReason: 'end_turn',
		})
		thread = update(thread, {
			kind: 'turn_ended',
			stopReason: 'end_turn',
			result: 'The settings match.',
		})
		const before = structuredClone(thread)
		const html = render(thread)
		for (const label of ['Update', 'Reasoning', 'Completed']) expect(html).toContain(label)
		const contents = [
			'Checking the saved settings.',
			'Compare the two recorded values.',
			'Actual settings content',
			'The settings match.',
		]
		for (let i = 1; i < contents.length; i++)
			expect(html.indexOf(contents[i - 1])).toBeLessThan(html.indexOf(contents[i]))
		expect(html).not.toContain('Ran Read settings')
		expect(thread).toEqual(before)
	})

	it('keeps restored commentary inside work details without inventing a successful outcome', () => {
		const thread = restoreMessages(emptyThread(), [
			{ role: 'user', text: 'Check' },
			{ role: 'assistant', text: 'Reading the file.', phase: 'commentary' },
			{ role: 'assistant', text: 'Verified.', phase: 'final_answer' },
		])
		const html = render(thread)
		expect(html).toContain('aria-label="Work details"')
		expect(html).toContain('Update')
		expect(html.indexOf('Reading the file.')).toBeLessThan(html.indexOf('Verified.'))
		expect(html).not.toContain('Worked')
	})

	it('does not invent bodies for redacted or whitespace-only reasoning and commentary', () => {
		let thread = update(started(), { kind: 'agent_thought_chunk', text: ' \n\t' })
		thread = update(thread, { kind: 'agent_message_chunk', text: '\n ', phase: 'commentary' })
		const html = render(thread)
		expect(html).not.toContain('data-activity-turn')
		expect(html).not.toContain('transcript-content-label')
		expect(html).toContain('Working')
		expect(thread.messages.at(-1)?.text).toBe('\n ')
	})
})

describe('truthful action receipts in normal and Pal views', () => {
	it('shows the matching approval wait, running sibling and real failed output without claiming a successful group', () => {
		let thread = started()
		for (const id of ['review', 'running', 'failed'])
			thread = update(thread, {
				kind: 'tool_call',
				toolCallId: id,
				title: 'exec',
				status: 'pending',
				view: { kind: 'terminal', command: `check-${id}`, output: '' },
			})
		thread = update(thread, {
			kind: 'tool_call',
			toolCallId: 'failed',
			title: 'exec',
			status: 'failed',
			view: { kind: 'terminal', command: 'check-failed', output: 'Exact error evidence' },
		})
		thread = applyEvent(thread, {
			kind: 'permission',
			request: {
				id: 'approval',
				sessionId: 's',
				projectId: 'p',
				calls: [{ id: 'review', name: 'exec', input: {}, isDestructive: false }],
			},
		})
		for (const html of [
			render(thread),
			renderToStaticMarkup(createElement(PalActivity, { thread })),
		]) {
			expect(html).toContain('data-tool-state="waiting"')
			expect(html).toContain('Waiting to run check-review')
			expect(html).toContain('data-tool-state="running"')
			expect(html).toContain('Command failed: check-failed')
			expect(html).toContain('Exact error evidence')
			expect(html).toContain('No output yet.')
			expect(html).not.toContain('Ran check-failed')
		}
		const normal = render(thread)
		expect(normal.match(/data-tool-call-id=/g)).toHaveLength(3)
		expect(normal).not.toContain('Commands · 1 waiting for approval, 1 running, 1 failed')
		expect(normal).not.toContain('Actions completed')
	})

	it('retains cancelled and hidden success captions without empty disclosures or false failures', () => {
		let thread = started()
		for (const id of ['plan', 'cancel'])
			thread = update(thread, {
				kind: 'tool_call',
				toolCallId: id,
				title: 'internal_tool_name',
				status: 'pending',
				view: {
					kind: 'generic',
					label: id === 'plan' ? 'Create a progress step' : 'Open the document',
				},
			})
		thread = update(thread, {
			kind: 'tool_call',
			toolCallId: 'plan',
			title: 'internal_tool_name',
			status: 'completed',
			view: { kind: 'generic', label: '', visibility: 'hidden' },
		})
		thread = update(thread, {
			kind: 'tool_call',
			toolCallId: 'cancel',
			title: 'internal_tool_name',
			status: 'failed',
			view: { kind: 'generic', label: 'Open the document', outcome: 'cancelled' },
		})
		for (const html of [
			render(thread),
			renderToStaticMarkup(createElement(PalActivity, { thread })),
		]) {
			expect(html).toContain('Create a progress step')
			expect(html).toContain('Completed')
			expect(html).toContain('data-tool-state="cancelled"')
			expect(html).toContain('Cancelled')
			expect(html).not.toContain('tool failed')
			expect(html).not.toContain('tool-content')
			expect(html.match(/Open the document<\/span>/g)).toHaveLength(1)
		}
	})
})
