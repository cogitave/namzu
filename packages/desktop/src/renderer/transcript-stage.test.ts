import { describe, expect, it } from 'vitest'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
import type { DesktopEvent } from '../shared/protocol.js'
import { clipStage, liveStatus, narrationBeingWritten, statedStage } from './transcript-motion.js'

const send = (thread: ThreadState, event: unknown) => applyEvent(thread, event as DesktopEvent)
const update = (thread: ThreadState, value: unknown) =>
	send(thread, { kind: 'update', sessionId: 's', update: value })

function live(): ThreadState {
	let thread = send(emptyThread(), { kind: 'prompt', sessionId: 's', prompt: 'go' })
	thread = send(thread, { kind: 'state', sessionId: 's', running: true, queued: [] })
	return thread
}
const think = (thread: ThreadState, text: string, blockId = 'b1') =>
	update(thread, { kind: 'agent_thought_chunk', text, blockId, messageId: 'm1' })
const tool = (thread: ThreadState, id: string, title: string, view: unknown, status = 'pending') =>
	update(thread, { kind: 'tool_call', toolCallId: id, title, status, view })

describe('statedStage', () => {
	it('takes a closed bold headline, or the first sentence once it ends', () => {
		expect(statedStage('**Checking the styles**\n\nI will open it.', false)).toBe(
			'Checking the styles',
		)
		expect(statedStage('Reading the notes first. Then more', false)).toBe(
			'Reading the notes first.',
		)
		expect(statedStage('First line\nsecond', false)).toBe('First line')
	})

	it('never shows what is still being written', () => {
		expect(statedStage('**Checking the sty', false)).toBeUndefined()
		expect(statedStage('Reading the notes', false)).toBeUndefined()
		expect(statedStage('', true)).toBeUndefined()
	})

	it('takes the whole text once the segment is finished', () => {
		expect(statedStage('Reading the notes', true)).toBe('Reading the notes')
		expect(statedStage('**Open bold', true)).toBe('Open bold')
	})

	it('strips markdown', () => {
		expect(statedStage('**Fix `app.css` [now](http://x)**', false)).toBe('Fix app.css now')
	})
})

it('cuts at a word boundary with an ellipsis, within 80 characters', () => {
	const text = `${'word '.repeat(30)}end`
	const clipped = clipStage(text)
	expect(clipped.length).toBeLessThanOrEqual(80)
	expect(clipped.endsWith('…')).toBe(true)
	expect(clipped.slice(0, -1).endsWith(' ')).toBe(false)
	expect(clipStage('short')).toBe('short')
})

const say = (thread: ThreadState, text: string, messageId = 'n1') =>
	update(thread, { kind: 'agent_message_chunk', text, phase: 'commentary', messageId })
const sayDone = (thread: ThreadState, text: string, messageId = 'n1') =>
	update(thread, { kind: 'agent_message', text, phase: 'commentary', messageId })
const done = (thread: ThreadState, id: string, command = 'ls') =>
	tool(thread, id, 'bash', { kind: 'terminal', command, output: 'x' }, 'completed')
const task = (thread: ThreadState, status: 'pending' | 'in_progress' | 'completed') =>
	send(thread, {
		kind: 'task',
		sessionId: 's',
		task: { taskId: 'a', subject: 'Run the tests', status, blockedBy: [] },
	})
const planTool = (thread: ThreadState, id: string) =>
	tool(thread, id, 'task_create', { kind: 'generic', label: 'Add task' }, 'completed')

describe('liveStatus', () => {
	it('is nothing when idle, and Thinking before anything has arrived', () => {
		expect(liveStatus(emptyThread())).toEqual({})
		expect(liveStatus(live())).toEqual({ stage: { text: 'Thinking', source: 'gap' } })
	})

	it('waits for a decision above everything, with no reasoning hidden', () => {
		const thread = send(think(live(), '**Planning**'), {
			kind: 'permission',
			request: {
				id: 'p',
				sessionId: 's',
				projectId: 'x',
				calls: [{ id: 'c', name: 'bash', input: {}, isDestructive: false }],
			},
		})
		expect(liveStatus(thread)).toEqual({
			stage: { text: 'Waiting for your decision', source: 'waiting' },
		})
	})

	it('turns the newest reasoning into the status line and stands its row down', () => {
		const thread = think(live(), '**Checking the styles**\n\nThe rows look tight.')
		expect(liveStatus(thread)).toEqual({
			stage: { text: 'Checking the styles', source: 'reasoning' },
			hiddenReasoningId: '1:b1',
		})
	})

	it('says Thinking, still hiding the row, while the headline is not yet written', () => {
		expect(liveStatus(think(live(), '**Checking the sty'))).toEqual({
			stage: { text: 'Thinking', source: 'gap' },
			hiddenReasoningId: '1:b1',
		})
	})

	it('draws the reasoning row again as soon as anything newer arrives', () => {
		let thread = think(live(), '**Checking the styles**')
		thread = tool(thread, 'c', 'bash', { kind: 'terminal', command: 'ls', output: '' })
		// A running action is the live element: no line, no hidden row.
		expect(liveStatus(thread)).toEqual({})
	})

	it('names the newest of two reasoning segments only', () => {
		let thread = think(live(), '**First**', 'b1')
		thread = done(thread, 'c')
		thread = think(thread, '**Second**', 'b2')
		expect(liveStatus(thread).stage?.text).toBe('Second')
		expect(liveStatus(thread).hiddenReasoningId).toBe('1:b2')
	})

	it('has no line while an action runs, and Thinking once it has finished and nothing followed', () => {
		let thread = tool(live(), 'c', 'bash', { kind: 'terminal', command: 'ls', output: '' })
		expect(liveStatus(thread)).toEqual({})
		thread = done(thread, 'c')
		expect(liveStatus(thread)).toEqual({ stage: { text: 'Thinking', source: 'gap' } })
	})

	it('has no line while narration is written, and Thinking once it is complete and nothing followed', () => {
		let thread = say(live(), 'I will read the notes, then update the styles.')
		expect(liveStatus(thread)).toEqual({})
		expect(narrationBeingWritten(thread)).toBeDefined()
		thread = sayDone(thread, 'I will read the notes, then update the styles.')
		expect(liveStatus(thread)).toEqual({ stage: { text: 'Thinking', source: 'gap' } })
		expect(narrationBeingWritten(thread)).toBeUndefined()
	})

	it('has no line while a plan step is in progress', () => {
		let thread = planTool(done(live(), 'c'), 't')
		thread = task(thread, 'pending')
		expect(liveStatus(thread).stage?.text).toBe('Thinking')
		thread = task(planTool(thread, 't2'), 'in_progress')
		expect(liveStatus(thread)).toEqual({})
		// The step shimmers in its row even when an action finished after it.
		expect(liveStatus(done(thread, 'e'))).toEqual({})
		expect(liveStatus(task(thread, 'completed')).stage?.text).toBe('Thinking')
	})

	it('ignores a task left in progress by an earlier turn', () => {
		let thread = task(planTool(live(), 't'), 'in_progress')
		thread = send(thread, { kind: 'prompt', sessionId: 's', prompt: 'next' })
		thread = send(thread, { kind: 'state', sessionId: 's', running: true, queued: [] })
		expect(liveStatus(thread).stage?.text).toBe('Thinking')
	})

	it('has no line once the answer is the newest entry', () => {
		const thread = update(live(), { kind: 'agent_message_chunk', text: 'Here.', messageId: 'a' })
		expect(liveStatus(thread)).toEqual({})
	})

	it('does not decide anything from elapsed time', () => {
		const thread = think(live(), '**Planning**')
		expect(liveStatus(thread)).toEqual(liveStatus(thread))
	})
})
