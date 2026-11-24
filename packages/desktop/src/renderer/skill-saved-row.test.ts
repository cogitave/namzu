import type { AcpSessionUpdate, ToolCallView } from '@namzu/sdk'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
import { ToolTranscriptRow } from './tool-transcript-row.js'

function thread(view: ToolCallView, status: 'completed' | 'failed' = 'completed'): ThreadState {
	const send = (state: ThreadState, update: AcpSessionUpdate): ThreadState =>
		applyEvent(state, {
			kind: 'update',
			sessionId: 's',
			projectId: 'p',
			update,
			at: 2000,
		})
	const started = applyEvent(
		applyEvent(emptyThread(), {
			kind: 'prompt',
			sessionId: 's',
			prompt: 'Go',
			at: 1000,
		}),
		{ kind: 'state', sessionId: 's', running: true, queued: [] },
	)
	const call: ToolCallView = {
		kind: 'generic',
		label: 'Propose skill release-notes',
		presentation: 'activity',
	}
	return send(
		send(started, {
			kind: 'tool_call',
			toolCallId: 't1',
			title: 'save_skill',
			status: 'pending',
			view: call,
		}),
		{ kind: 'tool_call', toolCallId: 't1', title: 'save_skill', status, view },
	)
}
const row = (state: ThreadState) => {
	const id = Object.keys(state.tools)[0] ?? ''
	return renderToStaticMarkup(createElement(ToolTranscriptRow, { thread: state, id }))
}

it('draws a saved skill as the saved card, with the place the engine wrote it to', () => {
	const html = row(
		thread({
			kind: 'generic',
			label: 'Saved skill "release-notes" to ~/.namzu/skills/release-notes/SKILL.md',
			presentation: 'activity',
		}),
	)
	expect(html).toContain('data-kind="skill-saved"')
	expect(html).toContain('Usable from your next message.')
	expect(html).toContain('~/.namzu/skills/release-notes/SKILL.md')
})

it('leaves a cancelled or failed save as an ordinary row', () => {
	const cancelled = row(
		thread({
			kind: 'generic',
			label: 'Cancelled — nothing was saved',
			outcome: 'cancelled',
		}),
	)
	expect(cancelled).not.toContain('skill-saved')
	const failed = row(
		thread(
			{
				kind: 'generic',
				label: 'Saved skill "x" to ~/y',
				presentation: 'activity',
			},
			'failed',
		),
	)
	expect(failed).not.toContain('skill-saved')
})
