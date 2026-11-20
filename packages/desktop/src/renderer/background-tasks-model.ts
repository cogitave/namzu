import type { JobView } from '../shared/protocol.js'
import { elapsedLabel } from './transcript-layout.js'

/**
 * What the Background tasks pane decides before it draws: which task is in which section and in what
 * order, what its row says, what its output tail shows and how often it is read again. Pure, so every
 * rule is a test with no window and no clock; the components only draw the answer.
 */

export const isRunning = (job: JobView): boolean => job.status === 'running'

/** A task whose stop was asked for and not yet confirmed keeps running, and keeps its Stop button. */
export const needsAttention = (job: JobView): boolean =>
	isRunning(job) && job.recoveryRequired === true

/** What a task is called: a monitor by what it watches, a command by its line. */
export function taskTitle(job: JobView): string {
	return job.kind === 'monitor'
		? `Monitoring: ${job.description || job.command || 'a command'}`
		: job.command || 'Background terminal'
}

export interface TaskSections {
	/** Oldest first: the one that has run longest is on top. */
	running: JobView[]
	/** Newest first: what ended last is on top. */
	finished: JobView[]
}

const endedAt = (job: JobView): number => job.completedAt ?? job.startedAt

/**
 * Splits the tasks into the two sections. A finished task the person cleared stays out; a task that
 * runs is never hidden, so a cleared one that starts again comes back.
 */
export function sectionTasks(
	jobs: readonly JobView[],
	dismissed: ReadonlySet<string> = new Set(),
): TaskSections {
	const running = jobs.filter(isRunning).sort((a, b) => a.startedAt - b.startedAt)
	const finished = jobs
		.filter((job) => !isRunning(job) && !dismissed.has(job.id))
		.sort((a, b) => endedAt(b) - endedAt(a))
	return { running, finished }
}

/** Keeps only the dismissed ids whose task still exists, so the saved list never grows without end. */
export function pruneDismissed(dismissed: readonly string[], jobs: readonly JobView[]): string[] {
	const known = new Set(jobs.map((job) => job.id))
	return dismissed.filter((id) => known.has(id))
}

/** The Finished section is open by default only while nothing runs; a choice the person made wins. */
export function finishedOpen(remembered: boolean | undefined, anyRunning: boolean): boolean {
	return remembered ?? !anyRunning
}

export type TaskTone = 'muted' | 'danger' | 'attention'

export interface TaskCaption {
	/** The state in words, when there is one worth saying; a task that simply ran says only how long. */
	words?: string
	tone: TaskTone
	/** Time so far while it runs; how long it took once it ended. Absent when not known. */
	time?: string
	/** The same time in full words, for a screen reader. */
	live: boolean
}

/** What the right side of a row says. `stopping` is the window's own state: the stop was asked for. */
export function taskCaption(job: JobView, now: number, stopping = false): TaskCaption {
	if (isRunning(job)) {
		const time = elapsedLabel(Math.max(0, now - job.startedAt))
		if (stopping) return { words: 'Stopping…', tone: 'muted', time, live: true }
		if (needsAttention(job))
			return { words: 'Needs attention', tone: 'attention', time, live: true }
		if (job.kind === 'monitor') return { words: 'Watching', tone: 'muted', time, live: true }
		return { tone: 'muted', time, live: true }
	}
	const time =
		job.completedAt !== undefined
			? elapsedLabel(Math.max(0, job.completedAt - job.startedAt))
			: undefined
	const base = { ...(time ? { time } : {}), live: false }
	if (job.kind === 'monitor') {
		if (job.stopReason === 'expired') return { words: 'Ran out of time', tone: 'muted', ...base }
		if (job.stopReason === 'too_much_output')
			return { words: 'Too much output', tone: 'muted', ...base }
	}
	if (job.status === 'killed') return { words: 'Stopped', tone: 'muted', ...base }
	if (job.status === 'exited') {
		if (job.exitCode !== undefined && job.exitCode !== 0)
			return { words: 'Failed', tone: 'danger', ...base }
		return { tone: 'muted', ...base }
	}
	return { words: 'Status unavailable', tone: 'muted', ...base }
}

/** "3 running", the short form's header. */
export const runningText = (count: number): string => `${count} running`
/** "2 finished", the link that opens the pane on its Finished section. */
export const finishedLinkText = (count: number): string => `${count} finished`

/** The composer's button: how many run, or how many are done when none does. Absent with no task. */
export function tasksButtonText(running: number, finished: number): string | undefined {
	if (running > 0) return `${running} running ${running === 1 ? 'task' : 'tasks'}`
	if (finished > 0) return `${finished} ${finished === 1 ? 'task' : 'tasks'} finished`
	return undefined
}

/** The pane's button in the bar shows while the conversation has tasks, or while the pane is open. */
export const showTasksButton = (taskCount: number, paneOpen: boolean): boolean =>
	taskCount > 0 || paneOpen

// ---------------------------------------------------------------------------------------- output

/** The most characters of output the row shows. */
export const TAIL_CHARS = 8000
/** An output this large is not drawn at all. */
export const TOO_LARGE_BYTES = 2 * 1024 * 1024
export const EARLIER_NOT_SHOWN = '(Earlier output not shown)'

/** How long until the tail is read again: 2 s, 5 s past 128 KB, 10 s past 512 KB. */
export function pollIntervalMs(size: number | undefined): number {
	if (size === undefined) return 2000
	if (size > 512_000) return 10_000
	if (size > 131_072) return 5000
	return 2000
}

export interface TailResult {
	output: string
	truncated?: boolean
	size?: number
}

export type TailView =
	| { kind: 'loading' }
	| { kind: 'unavailable' }
	| { kind: 'too-large' }
	| { kind: 'empty'; command: string }
	| { kind: 'text'; command: string; earlier: boolean; text: string }

/** What the output box shows for one read: the command line first, then the last 8000 characters. */
export function tailView(command: string, result: TailResult | 'error' | undefined): TailView {
	if (result === undefined) return { kind: 'loading' }
	if (result === 'error') return { kind: 'unavailable' }
	if ((result.size ?? 0) > TOO_LARGE_BYTES) return { kind: 'too-large' }
	let text = result.output
	let earlier = result.truncated === true
	if (text.length > TAIL_CHARS) {
		text = text.slice(-TAIL_CHARS)
		// The cut most likely fell inside a line: that first piece is dropped.
		const newline = text.indexOf('\n')
		if (newline >= 0) text = text.slice(newline + 1)
		earlier = true
	}
	if (text.trim() === '') return { kind: 'empty', command }
	return { kind: 'text', command, earlier, text }
}

/** Within this many pixels of the bottom, a new read keeps the box following the end. */
export const FOLLOW_SLACK_PX = 16
export const followsEnd = (
	scrollHeight: number,
	scrollTop: number,
	clientHeight: number,
): boolean => scrollHeight - scrollTop - clientHeight <= FOLLOW_SLACK_PX

export interface TailPollOptions {
	read: () => Promise<TailResult>
	onResult: (result: TailResult | 'error') => void
	/** True while the task still runs; after it ends one last read is made and the poll stops. */
	running: () => boolean
}

/**
 * Reads the output now, then again after `pollIntervalMs` of what it last saw, for as long as the
 * task runs. Returns the function that stops it. A read that fails is shown as unavailable and tried
 * again at the slowest pace.
 */
export function startTailPoll(options: TailPollOptions): () => void {
	let stopped = false
	let timer: ReturnType<typeof setTimeout> | undefined
	const tick = async (): Promise<void> => {
		let next = 10_000
		try {
			const result = await options.read()
			if (stopped) return
			options.onResult(result)
			next = pollIntervalMs(result.size)
		} catch {
			if (stopped) return
			options.onResult('error')
		}
		if (stopped || !options.running()) return
		timer = setTimeout(() => void tick(), next)
	}
	void tick()
	return () => {
		stopped = true
		if (timer !== undefined) clearTimeout(timer)
	}
}

// -------------------------------------------------------------------------- remembered choices

export interface TasksChoices {
	dismissed: string[]
	finishedOpen?: boolean
}

const KEY = 'namzu.background-tasks.1.'

export function parseChoices(raw: string | null | undefined): TasksChoices {
	if (!raw) return { dismissed: [] }
	try {
		const value: unknown = JSON.parse(raw)
		if (typeof value !== 'object' || value === null) return { dismissed: [] }
		const { dismissed, finishedOpen: open } = value as Record<string, unknown>
		return {
			dismissed: Array.isArray(dismissed)
				? dismissed.filter((id): id is string => typeof id === 'string').slice(-100)
				: [],
			...(typeof open === 'boolean' ? { finishedOpen: open } : {}),
		}
	} catch {
		return { dismissed: [] }
	}
}

export function readChoices(
	storage: Pick<Storage, 'getItem'> | undefined,
	sessionId: string,
): TasksChoices {
	try {
		return parseChoices(storage?.getItem(KEY + sessionId))
	} catch {
		return { dismissed: [] }
	}
}

export function writeChoices(
	storage: Pick<Storage, 'setItem'> | undefined,
	sessionId: string,
	choices: TasksChoices,
): void {
	try {
		storage?.setItem(KEY + sessionId, JSON.stringify(choices))
	} catch {
		// A blocked store only means the choice is not remembered.
	}
}

// ------------------------------------------------------------------------------------ transcript

/** What a background command's row says about its job, in the row's words. */
export function backgroundNote(job: JobView | undefined): { text: string; tone: 'dim' | 'err' } {
	if (!job) return { text: 'Started in background', tone: 'dim' }
	if (isRunning(job)) return { text: 'Running in background', tone: 'dim' }
	if (job.status === 'killed') return { text: 'Stopped in background', tone: 'dim' }
	if (job.exitCode !== undefined && job.exitCode !== 0)
		return { text: 'Failed in background', tone: 'err' }
	return { text: 'Finished in background', tone: 'dim' }
}

/** Said when the time limit, and not the person or the model, sent the command to the background. */
export const movedByLimitText = (limitMs: number): string =>
	`Moved to the background after its time limit of ${elapsedLabel(limitMs)}`
