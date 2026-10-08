import { describe, expect, it } from 'vitest'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
import type { DesktopEvent } from '../shared/protocol.js'
import { clipStage, liveStage, statedStage } from './transcript-motion.js'

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

describe('liveStage', () => {
	it('is nothing when idle and Working before anything is said', () => {
		expect(liveStage(emptyThread())).toBeUndefined()
		expect(liveStage(live())).toEqual({ text: 'Working', source: 'fallback' })
	})

	it('says Thinking while reasoning has no headline yet', () => {
		expect(liveStage(think(live(), 'let me'))?.text).toBe('Thinking')
	})

	it('names the action when nothing has been stated, verb first', () => {
		const thread = tool(live(), 'c', 'bash', {
			kind: 'terminal',
			command: 'pnpm test\n--silent',
			output: '',
		})
		expect(liveStage(thread)).toEqual({ text: 'Running pnpm test', source: 'action' })
		expect(
			liveStage(
				tool(live(), 'd', 'edit', {
					kind: 'diff',
					path: 'src/app.css',
					before: 'a',
					after: 'b',
				}),
			)?.text,
		).toBe('Editing app.css')
	})

	it('holds a finished action in the past tense, never as still running', () => {
		const thread = tool(
			live(),
			'c',
			'bash',
			{ kind: 'terminal', command: 'cat notes.md', output: 'x' },
			'completed',
		)
		expect(liveStage(thread)).toEqual({ text: 'Ran cat notes.md', source: 'action' })
	})

	it('holds a stated stage across any number of actions and deltas', () => {
		let thread = think(live(), '**Checking the styles**\n\n')
		const stage = liveStage(thread)
		expect(stage).toEqual({ text: 'Checking the styles', source: 'reasoning' })
		thread = think(thread, 'The rows look tight.')
		thread = tool(thread, 'c', 'bash', { kind: 'terminal', command: 'ls', output: '' })
		expect(liveStage(thread)).toEqual(stage)
	})

	it('keeps the earlier stage until a later one is complete', () => {
		let thread = think(live(), '**First stage**')
		thread = tool(thread, 'c', 'read', { kind: 'generic', label: 'x' }, 'completed')
		thread = think(thread, '**Second sta', 'b2')
		expect(liveStage(thread)?.text).toBe('First stage')
		thread = think(thread, 'ge**', 'b2')
		expect(liveStage(thread)?.text).toBe('Second stage')
	})

	it('follows whichever of reasoning and narration is later', () => {
		let thread = think(live(), '**Planning**')
		thread = update(thread, {
			kind: 'agent_message_chunk',
			text: 'Now I open the file. More follows',
			phase: 'commentary',
			messageId: 'n1',
		})
		expect(liveStage(thread)).toEqual({ text: 'Now I open the file.', source: 'narration' })
		thread = think(thread, '**Verifying**', 'b3')
		expect(liveStage(thread)).toEqual({ text: 'Verifying', source: 'reasoning' })
	})

	it('puts the task in progress above what was said, using its active form', () => {
		let thread = think(live(), '**Planning**')
		thread = tool(thread, 't', 'task_create', { kind: 'generic', label: 'Add task' }, 'completed')
		thread = send(thread, {
			kind: 'task',
			sessionId: 's',
			task: {
				taskId: 'a',
				subject: 'Run the tests',
				activeForm: 'Running the tests',
				status: 'in_progress',
				blockedBy: [],
			},
		})
		expect(liveStage(thread)).toEqual({ text: 'Running the tests', source: 'plan' })
		thread = send(thread, {
			kind: 'task',
			sessionId: 's',
			task: { taskId: 'a', subject: 'Run the tests', status: 'in_progress', blockedBy: [] },
		})
		expect(liveStage(thread)?.text).toBe('Run the tests')
	})

	it('ignores a task left in progress by an earlier turn', () => {
		let thread = tool(live(), 't', 'task_create', { kind: 'generic', label: 'x' }, 'completed')
		thread = send(thread, {
			kind: 'task',
			sessionId: 's',
			task: { taskId: 'a', subject: 'Old', status: 'in_progress', blockedBy: [] },
		})
		thread = send(thread, { kind: 'prompt', sessionId: 's', prompt: 'next' })
		thread = send(thread, { kind: 'state', sessionId: 's', running: true, queued: [] })
		expect(liveStage(thread)?.text).toBe('Working')
	})

	it('waits for a decision above everything', () => {
		const thread = send(think(live(), '**Planning**'), {
			kind: 'permission',
			request: {
				id: 'p',
				sessionId: 's',
				projectId: 'x',
				calls: [{ id: 'c', name: 'bash', input: {}, isDestructive: false }],
			},
		})
		expect(liveStage(thread)).toEqual({ text: 'Waiting for your decision', source: 'waiting' })
	})
})
