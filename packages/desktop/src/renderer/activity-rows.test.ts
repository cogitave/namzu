import type { AcpSessionUpdate, ToolCallView } from '@namzu/sdk'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type ThreadState,
	type TimelineEntry,
	applyEvent,
	emptyThread,
} from '../shared/projection.js'
import { fullPath, openAction, openTarget } from './activity-actions.js'
import { toolTranscriptPresentation } from './tool-transcript-presentation.js'
import {
	actionRunKind,
	actionRunLabel,
	runDefaultOpen,
	splitActivity,
} from './transcript-layout.js'
import { Transcript } from './transcript.js'
import type { TurnChanges } from './turn-changes.js'

function begin(): ThreadState {
	return applyEvent(
		applyEvent(emptyThread(), { kind: 'prompt', sessionId: 's', prompt: 'Go', at: 1000 }),
		{ kind: 'state', sessionId: 's', running: true, queued: [] },
	)
}
function update(thread: ThreadState, value: AcpSessionUpdate, at = 2000): ThreadState {
	return applyEvent(thread, {
		kind: 'update',
		sessionId: 's',
		projectId: 'p',
		update: value,
		at,
	})
}
function tool(
	thread: ThreadState,
	id: string,
	name: string,
	call: ToolCallView,
	status: 'pending' | 'completed' | 'failed' = 'completed',
	view: ToolCallView = call,
): ThreadState {
	const first = update(thread, {
		kind: 'tool_call',
		toolCallId: id,
		title: name,
		status: 'pending',
		view: call,
	})
	return status === 'pending'
		? first
		: update(first, { kind: 'tool_call', toolCallId: id, title: name, status, view })
}
const command = (text: string): ToolCallView => ({ kind: 'terminal', command: text, output: 'ok' })
const edit = (path: string, before = 'a', after = 'b'): ToolCallView => ({
	kind: 'diff',
	path,
	before,
	after,
})
const activity = (label: string): ToolCallView => ({
	kind: 'generic',
	label,
	presentation: 'activity',
	activity: 'exploration',
})
function row(thread: ThreadState, id: string) {
	return toolTranscriptPresentation(thread, `1:${id}`)
}
function finish(thread: ThreadState): ThreadState {
	return applyEvent(update(thread, { kind: 'turn_ended', stopReason: 'end_turn' }, 9000), {
		kind: 'state',
		sessionId: 's',
		running: false,
		queued: [],
	})
}

beforeEach(() => {
	vi.spyOn(Date, 'now').mockReturnValue(100000)
})
afterEach(() => {
	vi.restoreAllMocks()
})

describe('run summary labels', () => {
	const a = (kind: Parameters<typeof actionRunKind>[0][number]['kind'], subject?: string) => ({
		kind,
		subject,
		state: 'completed' as const,
	})
	it('says so when part of a run failed', () => {
		expect(
			actionRunLabel(
				[
					a('edit', 'a.ts'),
					{ ...a('command'), state: 'failed' },
					{ ...a('command'), state: 'failed' },
				],
				false,
			),
		).toBe('Edited a file, ran 2 commands, 2 failed')
	})
	it('does not count a declined action as work that happened', () => {
		const declined = (
			kind: Parameters<typeof actionRunKind>[0][number]['kind'],
			subject?: string,
		) => ({
			...a(kind, subject),
			state: 'declined' as const,
		})
		expect(actionRunLabel([declined('edit', 'a.ts'), declined('command')], false)).toBe(
			'Declined 2 actions',
		)
		expect(actionRunLabel([a('edit', 'b.ts'), declined('edit', 'a.ts')], false)).toBe(
			'Edited a file, declined an action',
		)
	})
	it('counts each kind in the order it first appears', () => {
		expect(actionRunLabel([a('edit', 'a.ts'), a('command'), a('command')], false)).toBe(
			'Edited a file, ran 2 commands',
		)
		expect(actionRunLabel([a('command'), a('edit', 'a.ts'), a('edit', 'b.ts')], false)).toBe(
			'Ran a command, edited 2 files',
		)
		expect(
			actionRunLabel([a('read', 'a'), a('read', 'b'), a('read', 'c'), a('read', 'd')], false),
		).toBe('Read 4 files')
		expect(actionRunLabel([a('search'), a('search'), a('search')], false)).toBe('Searched 3 times')
		expect(actionRunLabel([a('search'), a('web')], false)).toBe('Searched, searched the web')
		expect(actionRunLabel([a('other'), a('other')], false)).toBe('Used 2 tools')
	})
	it('counts a file once however often it was edited', () => {
		expect(actionRunLabel([a('edit', 'x.ts'), a('edit', 'x.ts')], false)).toBe('Edited a file')
	})
	it('uses the present tense while the run is live', () => {
		expect(actionRunLabel([a('edit', 'a'), a('command'), a('command')], true)).toBe(
			'Editing a file, running 2 commands',
		)
	})
	it('shows a pencil for any edit, otherwise the most common kind', () => {
		expect(actionRunKind([a('command'), a('command'), a('edit', 'a')])).toBe('edit')
		expect(actionRunKind([a('read'), a('command'), a('command')])).toBe('command')
		expect(actionRunKind([a('read'), a('command')])).toBe('read')
	})
	it('opens a run while it works or while it is short, and folds a long finished one', () => {
		expect(runDefaultOpen(true, 12)).toBe(true)
		expect(runDefaultOpen(false, 5)).toBe(true)
		expect(runDefaultOpen(false, 6)).toBe(false)
	})
})

describe('splitActivity', () => {
	it('splits runs at narration and reasoning', () => {
		const t = (id: string): TimelineEntry => ({ kind: 'tool', id, turn: 1 })
		const m = (index: number): TimelineEntry => ({ kind: 'message', index, turn: 1 })
		const parts = splitActivity([t('a'), t('b'), m(1), t('c'), m(2), t('d'), t('e'), t('f')])
		expect(parts.map((part) => ('run' in part ? part.run.length : 'entry'))).toEqual([
			2,
			'entry',
			1,
			'entry',
			3,
		])
	})
})

describe('action row labels', () => {
	it('words a command by its state and keeps the command for the tooltip', () => {
		let thread = tool(begin(), 'c', 'bash', command('pnpm test'), 'pending')
		expect(row(thread, 'c')).toMatchObject({
			label: 'Running command',
			kind: 'command',
			tooltip: 'pnpm test',
		})
		thread = tool(thread, 'c', 'bash', command('pnpm test'), 'completed')
		expect(row(thread, 'c')?.label).toBe('Ran command')
		thread = tool(thread, 'c', 'bash', command('pnpm test'), 'failed')
		expect(row(thread, 'c')?.label).toBe('Command failed')
	})
	it('keeps the tooltip to one line of at most 200 characters', () => {
		const thread = tool(begin(), 'c', 'bash', command(`echo ${'x'.repeat(400)}\nsecond line`))
		const tip = row(thread, 'c')?.tooltip ?? ''
		expect(tip.length).toBe(200)
		expect(tip).not.toContain('\n')
	})
	it('tells created, edited and deleted apart by the empty side', () => {
		let thread = tool(begin(), 'n', 'write', edit('/p/new.txt', '', 'x'))
		thread = tool(thread, 'e', 'edit', edit('src/app.css'))
		thread = tool(thread, 'd', 'write', edit('/p/old.txt', 'x', ''))
		expect(row(thread, 'n')).toMatchObject({
			label: 'Created new.txt',
			operation: 'created',
			file: { name: 'new.txt', path: '/p/new.txt' },
		})
		expect(row(thread, 'e')?.label).toBe('Edited app.css')
		expect(row(thread, 'd')?.label).toBe('Deleted old.txt')
	})
	it('words an edit that is live, waiting or failed', () => {
		let thread = tool(begin(), 'e', 'edit', edit('src/app.css'), 'pending')
		expect(row(thread, 'e')?.label).toBe('Editing app.css')
		thread = applyEvent(thread, {
			kind: 'permission',
			request: {
				id: 'a',
				sessionId: 's',
				projectId: 'p',
				calls: [{ id: 'e', name: 'edit', input: {}, isDestructive: false }],
			},
		})
		expect(row(thread, 'e')?.label).toBe('Waiting to edit app.css')
		thread = tool(thread, 'e', 'edit', edit('src/app.css'), 'failed')
		expect(row(thread, 'e')?.label).toBe("Couldn't edit app.css")
	})
	it('never offers the Before and After block for an edit', () => {
		const thread = tool(begin(), 'e', 'edit', edit('src/app.css'))
		expect(row(thread, 'e')?.detailView).toBeUndefined()
	})
	it('names a read by its file and a search by its pattern', () => {
		let thread = tool(begin(), 'r', 'read', activity('Read /p/notes.md'))
		thread = tool(thread, 'g', 'grep', activity('Search needle in src'))
		thread = tool(thread, 'l', 'glob', activity('Find **/*.ts in src/lib'))
		expect(row(thread, 'r')).toMatchObject({
			label: 'Read notes.md',
			kind: 'read',
			file: { name: 'notes.md', path: '/p/notes.md' },
		})
		expect(row(thread, 'g')).toMatchObject({ label: 'Searched for needle', kind: 'search' })
		expect(row(thread, 'l')).toMatchObject({ label: 'Listed files in src/lib', kind: 'search' })
	})
	it('clips a long search pattern to 60 characters and keeps the whole text for the tooltip', () => {
		const pattern = 'p'.repeat(90)
		const thread = tool(begin(), 'g', 'grep', activity(`Search ${pattern} in .`))
		expect(row(thread, 'g')?.label).toBe(`Searched for ${'p'.repeat(59)}…`)
		expect(row(thread, 'g')?.tooltip).toContain(pattern)
	})
	it('keeps the existing wording for tools it has no row for', () => {
		const thread = tool(begin(), 'x', 'plugin', { kind: 'generic', label: 'Do the thing' })
		expect(row(thread, 'x')).toMatchObject({ label: 'Do the thing', kind: 'other' })
	})
})

describe('full path and open target', () => {
	it('resolves a relative path against the project root and leaves an absolute one', () => {
		expect(fullPath('src/app.css', '/work/proj')).toBe('/work/proj/src/app.css')
		expect(fullPath('./src//app.css', '/work/proj/')).toBe('/work/proj/src/app.css')
		expect(fullPath('/abs/app.css', '/work/proj')).toBe('/abs/app.css')
		expect(fullPath('C:\\abs\\app.css', 'C:\\work')).toBe('C:\\abs\\app.css')
		expect(fullPath('src/app.css', 'C:\\work')).toBe('C:\\work\\src\\app.css')
		expect(fullPath('src/app.css')).toBe('src/app.css')
		expect(fullPath('../other/a.ts', '/work/proj')).toBe('/work/other/a.ts')
		expect(fullPath('..\\other\\a.ts', 'C:\\work\\proj')).toBe('C:\\work\\other\\a.ts')
		expect(fullPath('src/app.css', '/')).toBe('/src/app.css')
		expect(fullPath('\\\\srv\\share\\a.ts', 'C:\\work')).toBe('\\\\srv\\share\\a.ts')
	})
	const changes: TurnChanges = {
		turn: 1,
		files: [{ name: 'app.css', path: 'src/app.css', added: 1, removed: 0, receiptIds: ['r1'] }],
		added: 1,
		removed: 0,
		receiptIds: ['r1', 'r2'],
	}
	it('opens the Changes panel for a file the turn has a receipt for, else the file', () => {
		const onOpenTurnChanges = vi.fn()
		const onOpenChangedFile = vi.fn()
		const actions = { changes, onOpenTurnChanges, onOpenChangedFile }
		expect(openTarget(actions, 'src/app.css')).toBe('changes')
		expect(openTarget(actions, 'src/other.css')).toBe('file')
		expect(openTarget({ onOpenChangedFile }, 'src/app.css')).toBe('file')
		expect(openTarget({ changes }, 'src/app.css')).toBeUndefined()
		expect(openTarget(null, 'src/app.css')).toBeUndefined()
		openAction(actions, 'src/app.css')
		expect(onOpenTurnChanges).toHaveBeenCalledWith(['r1', 'r2'], 'src/app.css')
		openAction(actions, 'src/other.css')
		expect(onOpenChangedFile).toHaveBeenCalledWith('src/other.css')
	})
})

describe('rendered activity', () => {
	function work(): ThreadState {
		let thread = begin()
		thread = update(thread, {
			kind: 'agent_message_chunk',
			text: 'Checking first',
			phase: 'commentary',
			messageId: 'n1',
		})
		thread = tool(thread, 'c1', 'bash', command('ls'))
		thread = tool(thread, 'c2', 'bash', command('pwd'))
		thread = tool(thread, 'f1', 'write', edit('/p/new.txt', '', 'x'))
		thread = update(thread, {
			kind: 'agent_message_chunk',
			text: 'Now one edit',
			phase: 'commentary',
			messageId: 'n2',
		})
		thread = tool(thread, 'e1', 'edit', edit('/p/a.txt'))
		return finish(thread)
	}
	const render = (thread: ThreadState, props = {}) =>
		renderToStaticMarkup(createElement(Transcript, { thread, ...props }))

	it('summarises two or more actions and shows one action as its own row', () => {
		const html = render(work())
		expect(html).toContain('Ran 2 commands, edited a file')
		expect(html.match(/tool-run-trigger/g)).toHaveLength(1)
		expect(html.match(/data-tool-call-id=/g)).toHaveLength(4)
		expect(html).toContain('Edited')
	})
	it('folds the task tools into one plan row and never counts them as actions', () => {
		let thread = work()
		thread = {
			...thread,
			tasks: [
				{ taskId: 't1', subject: 'One', status: 'completed', blockedBy: [] },
				{ taskId: 't2', subject: 'Two', status: 'pending', blockedBy: [] },
			],
		}
		const generic: ToolCallView = {
			kind: 'generic',
			label: 'Add task · One',
			presentation: 'activity',
		}
		thread = tool(thread, 'k1', 'task_create', generic)
		thread = tool(thread, 'k2', 'task_update', generic)
		const html = render(thread)
		expect(html).toContain('Plan · 1/2')
		expect(html.match(/class="tool tool-group plan-row/g)).toHaveLength(1)
		expect(html).not.toContain('data-tool-call-id="k1"')
		expect(html).not.toContain('data-tool-call-id="k2"')
		expect(html).toContain('Ran 2 commands, edited a file')
	})
	it('has no scroll box around a run', () => {
		expect(render(work())).not.toContain('max-height')
	})
	it('folds a long finished run and keeps a short one open', () => {
		let thread = begin()
		for (let i = 0; i < 6; i++) thread = tool(thread, `c${i}`, 'bash', command(`echo ${i}`))
		const long = render(finish(thread))
		expect(long).toContain('Ran 6 commands')
		expect(long).toContain('data-closed')
		expect(render(work())).toContain('tool-group')
	})
	it('makes an edit row a button only when the caller can open it', () => {
		const thread = work()
		expect(render(thread)).not.toContain('tool-open')
		const html = render(thread, { onOpenChangedFile: () => {} })
		expect(html).toContain('class="tool-trigger tool-open"')
		expect(html).toContain('class="tool-file"')
	})
	it('draws the live header as one phrase without a second status line', () => {
		const thread = tool(begin(), 'c', 'bash', command('ls'), 'pending')
		const html = render(thread)
		expect(html).toContain('class="activity-text"')
		expect(html).toContain('data-live=""')
		expect(html).toContain('transcript-status-only')
	})
	it('names a failed action in the folded summary and gives the row its command as a description', () => {
		let thread = begin()
		for (let i = 0; i < 5; i++) thread = tool(thread, `c${i}`, 'bash', command(`echo ${i}`))
		thread = tool(thread, 'bad', 'bash', command('false'), 'failed')
		const html = render(finish(thread))
		expect(html).toContain('Ran 6 commands, 1 failed')
		expect(html).toContain('Command failed')
		expect(html).toContain('aria-description="false. Received at')
	})
	it('gives a path row its full path as a description', () => {
		const html = render(work(), { onOpenChangedFile: () => {}, projectRoot: '/work/proj' })
		expect(html).toContain('aria-description="/p/new.txt. Received at')
	})
	it('opens saved history closed', () => {
		expect(render(work())).toContain('aria-expanded="false"')
	})
})
