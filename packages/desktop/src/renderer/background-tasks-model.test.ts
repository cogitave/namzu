import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { JobView } from '../shared/protocol.js'
import {
	EARLIER_NOT_SHOWN,
	TAIL_CHARS,
	backgroundNote,
	finishedOpen,
	followsEnd,
	movedByLimitText,
	parseChoices,
	pollIntervalMs,
	pruneDismissed,
	sectionTasks,
	showTasksButton,
	startTailPoll,
	tailView,
	taskCaption,
	tasksButtonText,
} from './background-tasks-model.js'

const job = (over: Partial<JobView> & { id: string }): JobView => ({
	command: `cmd ${over.id}`,
	status: 'running',
	startedAt: 1000,
	...over,
})

it('puts running tasks oldest first and finished ones newest first, and hides cleared ones', () => {
	const jobs = [
		job({ id: 'r2', startedAt: 300 }),
		job({ id: 'r1', startedAt: 100 }),
		job({ id: 'f1', status: 'exited', exitCode: 0, startedAt: 10, completedAt: 50 }),
		job({ id: 'f2', status: 'killed', startedAt: 20, completedAt: 90 }),
		job({ id: 'f3', status: 'exited', exitCode: 1, startedAt: 30 }),
	]
	const sections = sectionTasks(jobs, new Set(['f1']))
	expect(sections.running.map((j) => j.id)).toEqual(['r1', 'r2'])
	expect(sections.finished.map((j) => j.id)).toEqual(['f2', 'f3'])
	// A cleared task that runs again is not hidden.
	expect(sectionTasks([job({ id: 'f1' })], new Set(['f1'])).running).toHaveLength(1)
	expect(pruneDismissed(['f1', 'gone'], jobs)).toEqual(['f1'])
})

it('opens Finished by default only while nothing runs, and a remembered choice wins', () => {
	expect(finishedOpen(undefined, false)).toBe(true)
	expect(finishedOpen(undefined, true)).toBe(false)
	expect(finishedOpen(false, false)).toBe(false)
	expect(finishedOpen(true, true)).toBe(true)
})

it('says what a row shows on its right side', () => {
	const done = { status: 'exited', startedAt: 1000, completedAt: 66_000 }
	expect(taskCaption(job({ id: 'a' }), 66_000)).toMatchObject({
		time: '1m 5s',
		tone: 'muted',
		live: true,
	})
	expect(taskCaption(job({ id: 'a' }), 66_000).words).toBeUndefined()
	expect(taskCaption(job({ id: 'a' }), 2000, true).words).toBe('Stopping…')
	expect(taskCaption(job({ id: 'a', recoveryRequired: true }), 2000)).toMatchObject({
		words: 'Needs attention',
		tone: 'attention',
	})
	expect(taskCaption(job({ id: 'm', kind: 'monitor' }), 2000).words).toBe('Watching')
	expect(taskCaption(job({ id: 'a', ...done, exitCode: 0 }), 0)).toEqual({
		tone: 'muted',
		time: '1m 5s',
		live: false,
	})
	expect(taskCaption(job({ id: 'a', ...done, exitCode: 2 }), 0)).toMatchObject({
		words: 'Failed',
		tone: 'danger',
	})
	expect(taskCaption(job({ id: 'a', ...done, status: 'killed' }), 0).words).toBe('Stopped')
	expect(
		taskCaption(job({ id: 'm', ...done, kind: 'monitor', stopReason: 'expired' }), 0).words,
	).toBe('Ran out of time')
	expect(
		taskCaption(job({ id: 'm', ...done, kind: 'monitor', stopReason: 'too_much_output' }), 0).words,
	).toBe('Too much output')
})

it('words the composer button and decides when the pane button shows', () => {
	expect(tasksButtonText(1, 4)).toBe('1 running task')
	expect(tasksButtonText(3, 0)).toBe('3 running tasks')
	expect(tasksButtonText(0, 1)).toBe('1 task finished')
	expect(tasksButtonText(0, 2)).toBe('2 tasks finished')
	expect(tasksButtonText(0, 0)).toBeUndefined()
	expect(showTasksButton(0, false)).toBe(false)
	expect(showTasksButton(0, true)).toBe(true)
	expect(showTasksButton(2, false)).toBe(true)
})

it('reads output at 2, 5 and 10 seconds by how much there is', () => {
	expect(pollIntervalMs(undefined)).toBe(2000)
	expect(pollIntervalMs(131_072)).toBe(2000)
	expect(pollIntervalMs(131_073)).toBe(5000)
	expect(pollIntervalMs(512_000)).toBe(5000)
	expect(pollIntervalMs(512_001)).toBe(10_000)
})

it('shows the last 8000 characters from a whole line and says earlier output is not shown', () => {
	const command = 'make'
	expect(tailView(command, undefined)).toEqual({ kind: 'loading' })
	expect(tailView(command, 'error')).toEqual({ kind: 'unavailable' })
	expect(tailView(command, { output: '  \n', size: 3 })).toEqual({ kind: 'empty', command })
	expect(tailView(command, { output: 'x', size: 3_000_000 })).toEqual({ kind: 'too-large' })
	expect(tailView(command, { output: 'a\nb\n', size: 4 })).toEqual({
		kind: 'text',
		command,
		earlier: false,
		text: 'a\nb\n',
	})
	expect(tailView(command, { output: 'a\n', truncated: true })).toMatchObject({ earlier: true })
	const long = `${'first line\n'.repeat(1000)}last\n`
	const view = tailView(command, { output: long, size: long.length })
	expect(view.kind).toBe('text')
	if (view.kind !== 'text') return
	expect(view.earlier).toBe(true)
	expect(view.text.length).toBeLessThanOrEqual(TAIL_CHARS)
	expect(view.text.startsWith('first line\n')).toBe(true)
	expect(view.text.endsWith('last\n')).toBe(true)
	expect(EARLIER_NOT_SHOWN).toBe('(Earlier output not shown)')
})

it('follows the end unless scrolled up more than 16 pixels', () => {
	expect(followsEnd(1000, 700, 300)).toBe(true)
	expect(followsEnd(1000, 684, 300)).toBe(true)
	expect(followsEnd(1000, 683, 300)).toBe(false)
})

it('words a background command by its job', () => {
	expect(backgroundNote(undefined).text).toBe('Started in background')
	expect(backgroundNote(job({ id: 'a' })).text).toBe('Running in background')
	expect(backgroundNote(job({ id: 'a', status: 'exited', exitCode: 0 })).text).toBe(
		'Finished in background',
	)
	expect(backgroundNote(job({ id: 'a', status: 'exited', exitCode: 3 }))).toEqual({
		text: 'Failed in background',
		tone: 'err',
	})
	expect(backgroundNote(job({ id: 'a', status: 'killed' })).text).toBe('Stopped in background')
	expect(movedByLimitText(120_000)).toBe('Moved to the background after its time limit of 2m 0s')
})

it('reads remembered choices and ignores what is not well formed', () => {
	expect(parseChoices('{"dismissed":["a",3],"finishedOpen":false}')).toEqual({
		dismissed: ['a'],
		finishedOpen: false,
	})
	expect(parseChoices('nope')).toEqual({ dismissed: [] })
	expect(parseChoices(null)).toEqual({ dismissed: [] })
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('polls by the size it last saw while the task runs, then makes one last read and stops', async () => {
	let running = true
	const sizes = [10, 200_000, 600_000]
	const reads: number[] = []
	const seen: unknown[] = []
	const stop = startTailPoll({
		read: async () => {
			reads.push(Date.now())
			return { output: 'x', size: sizes.shift() ?? 0 }
		},
		onResult: (result) => seen.push(result),
		running: () => running,
	})
	await vi.advanceTimersByTimeAsync(0)
	expect(reads).toHaveLength(1)
	await vi.advanceTimersByTimeAsync(1999)
	expect(reads).toHaveLength(1)
	await vi.advanceTimersByTimeAsync(1)
	expect(reads).toHaveLength(2)
	// The second read saw 200 KB: the next is 5 s later.
	await vi.advanceTimersByTimeAsync(4999)
	expect(reads).toHaveLength(2)
	await vi.advanceTimersByTimeAsync(1)
	expect(reads).toHaveLength(3)
	// The task ends: the read already waiting is the last one, and nothing follows it.
	running = false
	await vi.advanceTimersByTimeAsync(10_000)
	expect(reads).toHaveLength(4)
	await vi.advanceTimersByTimeAsync(60_000)
	expect(reads).toHaveLength(4)
	stop()
	expect(seen).toHaveLength(4)
})

it('shows a failed read as unavailable and tries again slowly', async () => {
	const seen: unknown[] = []
	let calls = 0
	const stop = startTailPoll({
		read: async () => {
			calls++
			throw new Error('gone')
		},
		onResult: (result) => seen.push(result),
		running: () => true,
	})
	await vi.advanceTimersByTimeAsync(0)
	expect(seen).toEqual(['error'])
	await vi.advanceTimersByTimeAsync(9999)
	expect(calls).toBe(1)
	await vi.advanceTimersByTimeAsync(1)
	expect(calls).toBe(2)
	stop()
	await vi.advanceTimersByTimeAsync(60_000)
	expect(calls).toBe(2)
})
