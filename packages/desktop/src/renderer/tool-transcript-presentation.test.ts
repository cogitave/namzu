import type { ToolCallView } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
import { toolTranscriptPresentation } from './tool-transcript-presentation.js'

function start(view: ToolCallView, title = 'custom_tool'): ThreadState {
	let thread = applyEvent(emptyThread(), {
		kind: 'prompt',
		sessionId: 'session',
		prompt: 'Do the work',
	})
	thread = applyEvent(thread, { kind: 'state', sessionId: 'session', running: true, queued: [] })
	return result(thread, view, 'pending', title)
}
function result(
	thread: ThreadState,
	view: ToolCallView,
	status: 'pending' | 'completed' | 'failed',
	title = 'custom_tool',
): ThreadState {
	return applyEvent(thread, {
		kind: 'update',
		sessionId: 'session',
		projectId: 'project',
		update: { kind: 'tool_call', toolCallId: 'call', title, status, view },
	})
}
const key = '1:call'

it('keeps a proved skipped historical action distinct from successful execution', () => {
	const thread = result(
		start({ kind: 'generic', label: 'Saved action' }),
		{
			kind: 'generic',
			label: 'Skipped action\nDetails were not recorded.',
		},
		'completed',
	)
	thread.running = false
	thread.tools[key] = { ...thread.tools[key]!, historicalStatus: 'skipped' }
	expect(toolTranscriptPresentation(thread, key)).toMatchObject({
		state: 'skipped',
		statusLabel: 'Skipped',
	})
})

it('does not admit a historical display marker from a live ACP action update', () => {
	for (const status of ['pending', 'failed'] as const) {
		const thread = applyEvent(start({ kind: 'generic', label: 'Read the guide' }), {
			kind: 'update',
			sessionId: 'session',
			projectId: 'project',
			update: {
				kind: 'tool_call',
				toolCallId: 'call',
				title: 'Read the guide',
				status,
				view: { kind: 'generic', label: 'Read the guide' },
				historicalStatus: 'skipped',
			} as never,
		})
		expect(thread.tools[key]?.historicalStatus).toBeUndefined()
		expect(toolTranscriptPresentation(thread, key)?.state).toBe(
			status === 'pending' ? 'running' : 'failed',
		)
	}
})

describe('authored tool content', () => {
	it('preserves a task action caption when success adds no receipt, without deleting the tool or mutating state', () => {
		const thread = result(
			start({ kind: 'generic', label: 'Add task · Verify output', presentation: 'activity' }),
			{ kind: 'generic', label: '', visibility: 'hidden' },
			'completed',
		)
		const before = structuredClone(thread)
		expect(toolTranscriptPresentation(thread, key)).toEqual({
			label: 'Add task · Verify output',
			state: 'completed',
			statusLabel: 'Completed',
		})
		expect(thread).toEqual(before)
		expect(thread.tools[key]?.view).toEqual({ kind: 'generic', label: '', visibility: 'hidden' })
	})

	it('renders a single authored line once but keeps different or multiline result evidence inspectable', () => {
		const call = start({
			kind: 'generic',
			label: 'Read the project guide',
			presentation: 'activity',
		})
		expect(toolTranscriptPresentation(call, key)?.detailView).toBeUndefined()
		const different: ToolCallView = { kind: 'generic', label: 'The guide is unavailable' }
		const failed = result(call, different, 'failed')
		expect(toolTranscriptPresentation(failed, key)).toMatchObject({
			label: 'Read the project guide',
			state: 'failed',
			detailView: different,
		})
		const multiline: ToolCallView = {
			kind: 'generic',
			label: 'Read the project guide\nImportant detail',
		}
		expect(toolTranscriptPresentation(result(call, multiline, 'completed'), key)?.detailView).toBe(
			multiline,
		)
	})

	it('shows an explicit user cancellation neutrally and retains its explanation', () => {
		const view: ToolCallView = {
			kind: 'generic',
			label: 'Cancelled — nothing was saved',
			outcome: 'cancelled',
		}
		const cancelled = result(start({ kind: 'generic', label: 'Propose a skill' }), view, 'failed')
		expect(toolTranscriptPresentation(cancelled, key)).toEqual({
			label: 'Propose a skill',
			state: 'cancelled',
			statusLabel: 'Cancelled',
			detailView: view,
		})
		expect(cancelled.tools[key]?.status).toBe('failed')
	})

	it('never uses the hidden-success hint to discard failed result text', () => {
		const view: ToolCallView = {
			kind: 'generic',
			label: 'Nothing could be saved',
			visibility: 'hidden',
		}
		const thread = result(start({ kind: 'generic', label: 'Save the note' }), view, 'failed')
		expect(toolTranscriptPresentation(thread, key)?.detailView).toBe(view)
	})

	it('keeps completion-only legacy rows readable and unknown tools independent of name matching', () => {
		const thread = result(
			emptyThread(),
			{ kind: 'generic', label: '', visibility: 'hidden' },
			'completed',
			'plugin operation',
		)
		expect(toolTranscriptPresentation(thread, '0:call')).toEqual({
			label: 'plugin operation',
			state: 'completed',
			statusLabel: 'Completed',
		})
		expect(toolTranscriptPresentation(thread, 'missing')).toBeUndefined()
	})

	it('ignores whitespace-only captions and commands without changing substantive authored evidence', () => {
		const hidden = result(
			emptyThread(),
			{ kind: 'generic', label: '', visibility: 'hidden' },
			'completed',
			' \n ',
		)
		expect(toolTranscriptPresentation(hidden, '0:call')?.label).toBe('Tool action')
		const diff: ToolCallView = {
			kind: 'diff',
			label: '  \n ',
			path: 'note.txt',
			before: 'Original bytes',
			after: 'Actual changed bytes',
		}
		expect(
			toolTranscriptPresentation(result(emptyThread(), diff, 'completed'), '0:call'),
		).toMatchObject({
			label: 'Edited note.txt',
			detailView: diff,
		})
		const authored = { ...diff, label: '  Change the summary  ' }
		expect(
			toolTranscriptPresentation(result(emptyThread(), authored, 'completed'), '0:call')?.label,
		).toBe(authored.label)
		const read = start({
			kind: 'generic',
			label: 'Read the project guide',
			presentation: 'activity',
		})
		const output: ToolCallView = { kind: 'terminal', command: ' \n ', output: 'Actual guide text' }
		expect(toolTranscriptPresentation(result(read, output, 'completed'), key)).toMatchObject({
			label: 'Read the project guide',
			detailView: output,
		})
	})
})

describe('actual tool lifecycle', () => {
	it('calls only the exact active pending action waiting, not sibling actions or a settled/historical call', () => {
		let thread = start({ kind: 'terminal', command: 'pwd', output: '' })
		thread = applyEvent(thread, {
			kind: 'permission',
			request: {
				id: 'approval',
				sessionId: 'session',
				projectId: 'project',
				calls: [{ id: 'other-call', name: 'exec', input: {}, isDestructive: false }],
			},
		})
		expect(toolTranscriptPresentation(thread, key)?.state).toBe('running')
		thread = applyEvent(thread, {
			kind: 'permission',
			request: {
				id: 'matching',
				sessionId: 'session',
				projectId: 'project',
				calls: [{ id: 'call', name: 'exec', input: {}, isDestructive: false }],
			},
		})
		expect(toolTranscriptPresentation(thread, key)).toMatchObject({
			label: 'Waiting to run pwd',
			state: 'waiting',
			statusLabel: 'Waiting for approval',
		})
		expect(
			toolTranscriptPresentation(
				result(thread, { kind: 'terminal', command: 'pwd', output: 'workspace' }, 'completed'),
				key,
			)?.state,
		).toBe('completed')
		thread = applyEvent(thread, { kind: 'state', sessionId: 'session', running: false, queued: [] })
		expect(toolTranscriptPresentation(thread, key)?.state).toBe('interrupted')
		thread = applyEvent(thread, { kind: 'prompt', sessionId: 'session', prompt: 'Next' })
		thread = applyEvent(thread, { kind: 'state', sessionId: 'session', running: true, queued: [] })
		expect(toolTranscriptPresentation(thread, key)?.state).toBe('interrupted')
	})

	it('labels failed commands truthfully but does not call a plain result a command execution', () => {
		const terminal = start({ kind: 'terminal', command: 'pwd', output: '' })
		expect(toolTranscriptPresentation(terminal, key)?.label).toBe('Running pwd')
		expect(
			toolTranscriptPresentation(
				result(terminal, { kind: 'terminal', command: 'pwd', output: 'Actual failure' }, 'failed'),
				key,
			)?.label,
		).toBe('Command failed: pwd')
		expect(
			toolTranscriptPresentation(
				result(terminal, { kind: 'terminal', output: 'workspace' }, 'completed'),
				key,
			)?.label,
		).toBe('Ran pwd')
		const read = start({
			kind: 'generic',
			label: 'Read the project guide',
			presentation: 'activity',
		})
		const output: ToolCallView = { kind: 'terminal', output: 'Actual guide text' }
		expect(toolTranscriptPresentation(result(read, output, 'completed'), key)).toMatchObject({
			label: 'Read the project guide',
			detailView: output,
		})
	})

	it('does not turn a pending generic view into a completed cancellation', () => {
		const thread = start({ kind: 'generic', label: 'Prepare the proposal', outcome: 'cancelled' })
		expect(toolTranscriptPresentation(thread, key)?.state).toBe('running')
	})
})
