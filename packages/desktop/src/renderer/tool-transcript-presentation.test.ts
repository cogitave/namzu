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
	it('names an actual conversation lookup without pretending its query was a web search', () => {
		const pending = start(
			{ kind: 'generic', label: 'web_search', presentation: 'activity' },
			'search_conversation',
		)
		const completed = result(
			pending,
			{ kind: 'terminal', output: 'Matching prior messages' },
			'completed',
			'search_conversation',
		)
		expect(toolTranscriptPresentation(completed, key)).toMatchObject({
			label: 'Checked earlier messages',
			state: 'completed',
			quietCompleted: true,
			callDetail: { kind: 'generic', label: 'web_search' },
			detailView: { kind: 'terminal', output: 'Matching prior messages' },
		})
		expect(toolTranscriptPresentation(pending, key)?.label).toBe('Checking earlier messages')
		expect(
			toolTranscriptPresentation(
				result(pending, { kind: 'terminal', output: '' }, 'failed', 'search_conversation'),
				key,
			)?.label,
		).toBe('Could not check earlier messages')
		const actualOtherTool = result(
			start({ kind: 'generic', label: 'web_search' }, 'other_tool'),
			{ kind: 'generic', label: 'web_search' },
			'completed',
			'other_tool',
		)
		expect(toolTranscriptPresentation(actualOtherTool, key)?.label).toBe('web_search')
	})

	it('keeps provider-hosted search state separate from local earlier-message checks', () => {
		const thread = result(
			start({ kind: 'generic', label: '' }, 'Web search'),
			{ kind: 'generic', label: 'Web search: H100 price · 10 sources' },
			'completed',
			'Web search',
		)
		thread.tools[key] = {
			...thread.tools[key]!,
			toolCallId: 'provider-hosted-web-search:2:actual-provider-id',
		}
		expect(toolTranscriptPresentation(thread, key)).toMatchObject({
			label: 'Searched the web',
			state: 'completed',
			quietCompleted: true,
			detailView: { kind: 'generic', label: 'Web search: H100 price · 10 sources' },
		})
	})

	it('preserves a task action caption when success adds no receipt, without deleting the tool or mutating state', () => {
		const thread = result(
			start({ kind: 'generic', label: 'Add task · Verify output', presentation: 'activity' }),
			{ kind: 'generic', label: '', visibility: 'hidden' },
			'completed',
		)
		const before = structuredClone(thread)
		expect(toolTranscriptPresentation(thread, key)).toEqual({
			label: 'Add task · Verify output',
			kind: 'other',
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
			kind: 'other',
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
			kind: 'other',
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
			kind: 'edit',
			file: { name: 'note.txt', path: 'note.txt' },
		})
		// The Before/After block is not drawn in the transcript; the Changes panel shows it.
		expect(
			toolTranscriptPresentation(result(emptyThread(), diff, 'completed'), '0:call')?.detailView,
		).toBeUndefined()
		const unnamed = { ...diff, path: undefined, label: '  Change the summary  ' }
		expect(
			toolTranscriptPresentation(result(emptyThread(), unnamed, 'completed'), '0:call')?.label,
		).toBe(unnamed.label)
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
			label: 'Waiting to run command',
			tooltip: 'pwd',
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

	it('opens nothing for a failed command whose output was not kept', () => {
		const terminal = start({ kind: 'terminal', command: 'false', output: '' })
		const failed = result(terminal, { kind: 'terminal', command: 'false', output: '' }, 'failed')
		expect(toolTranscriptPresentation(failed, key)?.detailView).toBeUndefined()
	})

	it('labels failed commands truthfully but does not call a plain result a command execution', () => {
		const terminal = start({ kind: 'terminal', command: 'pwd', output: '' })
		expect(toolTranscriptPresentation(terminal, key)?.label).toBe('Running command')
		expect(
			toolTranscriptPresentation(
				result(terminal, { kind: 'terminal', command: 'pwd', output: 'Actual failure' }, 'failed'),
				key,
			)?.label,
		).toBe('Command failed')
		expect(
			toolTranscriptPresentation(
				result(terminal, { kind: 'terminal', output: 'workspace' }, 'completed'),
				key,
			)?.label,
		).toBe('Ran command')
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

describe('a call the person declined', () => {
	const declined = (title: string, label: string, note?: string) =>
		result(
			start({ kind: 'diff', path: '/repo/src/app.css', before: 'a', after: 'b' }, title),
			{ kind: 'generic', label, declined: note ? { note } : {} },
			'failed',
			title,
		)

	it('reads "Declined edit to app.css" in a state of its own, not as a failure', () => {
		const row = toolTranscriptPresentation(
			declined('edit', '/repo/src/app.css', 'Keep the old colour.'),
			key,
		)
		expect(row).toMatchObject({
			label: 'Declined edit to app.css',
			lead: 'Declined edit to',
			kind: 'edit',
			state: 'declined',
			statusLabel: 'Declined',
			file: { name: 'app.css', path: '/repo/src/app.css' },
		})
	})

	it('carries what the person said as a note, and has none without one', () => {
		const withNote = toolTranscriptPresentation(
			declined('edit', '/repo/src/app.css', 'Keep the old colour.'),
			key,
		)
		expect(withNote?.note).toBe('Keep the old colour.')
		expect(withNote?.detailView).toBeUndefined()
		const bare = toolTranscriptPresentation(declined('edit', '/repo/src/app.css'), key)
		expect(bare?.note).toBeUndefined()
	})

	it('names a declined command and a declined write', () => {
		expect(
			toolTranscriptPresentation(declined('bash', 'rm -rf build\nsecond line'), key),
		).toMatchObject({
			label: 'Declined command',
			kind: 'command',
			tooltip: 'rm -rf build',
			state: 'declined',
		})
		expect(toolTranscriptPresentation(declined('write', 'notes/todo.md'), key)).toMatchObject({
			label: 'Declined write to todo.md',
		})
		expect(toolTranscriptPresentation(declined('fetch_page', 'https://x.test'), key)).toMatchObject(
			{
				label: 'Declined fetch page',
				state: 'declined',
			},
		)
	})

	it('leaves a refusal that carries no declined field as a failure', () => {
		const refused = result(
			start({ kind: 'generic', label: 'Edit app.css' }, 'edit'),
			{ kind: 'generic', label: 'Error: Tool "edit" was not executed. Strict mode.' },
			'failed',
			'edit',
		)
		expect(toolTranscriptPresentation(refused, key)?.state).toBe('failed')
	})
})

it('does not open a finished command that printed nothing', () => {
	const thread = result(
		start({ kind: 'generic', label: 'ls' }, 'bash'),
		{ kind: 'terminal', command: 'ls', output: '' },
		'completed',
		'bash',
	)
	expect(toolTranscriptPresentation(thread, key)?.detailView).toBeUndefined()
	expect(toolTranscriptPresentation(thread, key)?.tooltip).toBe('ls')
})

describe('a message to a Pal from an ordinary conversation', () => {
	const call = (status: 'pending' | 'completed' | 'failed', label: string, callLabel?: string) => {
		let thread = start(
			{ kind: 'generic', label: callLabel ?? label, presentation: 'activity' },
			'send_pal_message',
		)
		if (status !== 'pending')
			thread = result(
				thread,
				{ kind: 'generic', label, presentation: 'activity' },
				status,
				'send_pal_message',
			)
		return thread
	}

	it('names the Pal while it runs, and says the message reached the inbox once it is sent', () => {
		expect(toolTranscriptPresentation(call('pending', 'Message to Review'), key)).toMatchObject({
			label: 'Messaging Review',
			state: 'running',
		})
		const sent = toolTranscriptPresentation(
			call('completed', "Sent to Review's inbox", 'Message to Review'),
			key,
		)
		expect(sent).toMatchObject({
			label: 'Messaged Review',
			tooltip: 'Sent to inbox',
			state: 'completed',
		})
		expect(sent?.detailView).toBeUndefined()
	})

	it('reads the Pal from the saved receipt label after the conversation is reloaded', () => {
		expect(
			toolTranscriptPresentation(call('completed', "Sent to Review's inbox"), key),
		).toMatchObject({ label: 'Messaged Review', tooltip: 'Sent to inbox' })
		expect(toolTranscriptPresentation(call('completed', 'Message to Review'), key)?.label).toBe(
			'Messaged Review',
		)
	})

	it('does not claim the message was sent when it failed or was declined', () => {
		const failed = toolTranscriptPresentation(call('failed', 'Message to Review'), key)
		expect(failed).toMatchObject({ label: "Couldn't message Review", state: 'failed' })
		expect(failed?.tooltip).toBeUndefined()
		const declined = result(
			start({ kind: 'generic', label: 'Message to Review' }, 'send_pal_message'),
			{ kind: 'generic', label: 'Message to Review', declined: {} },
			'failed',
			'send_pal_message',
		)
		expect(toolTranscriptPresentation(declined, key)).toMatchObject({
			label: 'Declined message to Review',
			state: 'declined',
		})
	})

	it('leaves a Pal-to-Pal row, which names no Pal, as it was', () => {
		const row = toolTranscriptPresentation(
			result(
				start({ kind: 'generic', label: 'send_pal_message' }, 'send_pal_message'),
				{ kind: 'generic', label: 'send_pal_message' },
				'completed',
				'send_pal_message',
			),
			key,
		)
		expect(row?.label).toBe('send_pal_message')
		expect(row?.tooltip).toBeUndefined()
	})
})
