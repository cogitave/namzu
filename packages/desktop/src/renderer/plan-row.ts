import type { AcpTask } from '@namzu/sdk'
import type { ThreadState, TimelineEntry } from '../shared/projection.js'

// The tools that keep the plan. Their rows fold into one plan row; they are never counted as actions.
const taskTools = new Set([
	'taskcreate',
	'taskupdate',
	'tasklist',
	'taskget',
	'todowrite',
	'updateplan',
])

/** Matches `task_create`, `TaskCreate`, `server.task_create`, `engine:TodoWrite` and `mcp__server__TodoWrite` alike. */
export function isTaskTool(name: string | undefined): boolean {
	if (!name) return false
	const last =
		name
			.split(/[.:]|__/)
			.filter(Boolean)
			.pop() ?? name
	return taskTools.has(last.toLowerCase().replace(/[^a-z0-9]/g, ''))
}

type Tools = Pick<ThreadState, 'tools'> & Partial<Pick<ThreadState, 'tasks'>>

// An external engine's own list tools emit no task events, so folding them away would hide
// all of its progress. They fold only once the thread holds a plan to fold them into.
const engineTools = new Set(['todowrite', 'updateplan'])

function isEngineTaskTool(name: string | undefined): boolean {
	const last =
		name
			?.split(/[.:]|__/)
			.filter(Boolean)
			.pop() ??
		name ??
		''
	return engineTools.has(last.toLowerCase().replace(/[^a-z0-9]/g, ''))
}

export function isTaskEntry(thread: Tools, entry: TimelineEntry): boolean {
	if (entry.kind !== 'tool') return false
	const title = thread.tools[entry.id]?.title
	if (!isTaskTool(title)) return false
	return !isEngineTaskTool(title) || (thread.tasks?.length ?? 0) > 0
}

/** The last turn in which the plan was touched; only that turn draws the live plan. */
export function latestPlanTurn(thread: Tools & Pick<ThreadState, 'timeline'>): number | undefined {
	for (let index = thread.timeline.length - 1; index >= 0; index--) {
		const entry = thread.timeline[index]
		if (entry && isTaskEntry(thread, entry)) return entry.turn
	}
	return undefined
}

export interface PlanSummary {
	total: number
	done: number
	failed: number
	/** Every task is completed. */
	finished: boolean
	/** The first task being worked on. */
	current?: AcpTask
}

export function planSummary(tasks: readonly AcpTask[]): PlanSummary {
	const done = tasks.filter((task) => task.status === 'completed').length
	return {
		total: tasks.length,
		done,
		failed: tasks.filter((task) => task.status === 'failed').length,
		finished: tasks.length > 0 && done === tasks.length,
		current: tasks.find((task) => task.status === 'in_progress'),
	}
}

export interface PlanLabel {
	text: string
	/** The in-progress task, drawn after the count. */
	current?: string
	/** Finished plans read muted; one left unfinished at the end of the turn reads in normal text. */
	tone: 'live' | 'muted' | 'normal'
}

export function planLabel(summary: PlanSummary, turnLive: boolean): PlanLabel {
	const count = `${summary.done}/${summary.total}`
	if (summary.finished) return { text: `Plan · ${count} done`, tone: 'muted' }
	if (turnLive)
		return {
			text: `Plan · ${count}`,
			...(summary.current ? { current: summary.current.subject } : {}),
			tone: 'live',
		}
	return { text: `Plan · ${count}`, tone: 'normal' }
}

/** Rows drawn before the list folds to "+N more". */
export const planRowLimit = 6

export function planVisibleTasks(tasks: readonly AcpTask[]): {
	shown: readonly AcpTask[]
	more: number
} {
	return { shown: tasks.slice(0, planRowLimit), more: Math.max(0, tasks.length - planRowLimit) }
}
