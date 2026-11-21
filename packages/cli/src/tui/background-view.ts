/**
 * What the Background dialog lists, as plain data.
 *
 * One list for everything running behind the conversation: background
 * commands, monitors and the subagents of this conversation. Subagents that
 * have ended move to their own section; commands and monitors stay in theirs
 * with an ended word until the session closes.
 */

import type { BackgroundJob, SessionTimer } from '@namzu/sdk'
import {
	DEFAULT_AGENT_WORKFLOW,
	type SubagentActivity,
} from '../integrations/subagents/activity.js'
import { launchLabel } from './agent-transcript-rows.js'
import { isRunning } from './background-agents.js'

export type BackgroundSection = 'shells' | 'monitors' | 'agents' | 'timers' | 'completed'

export const BACKGROUND_SECTION_TITLES: Readonly<Record<BackgroundSection, string>> = {
	shells: 'Shells',
	monitors: 'Monitors',
	agents: 'Local agents',
	timers: 'Timers',
	completed: 'Completed',
}

const SECTION_ORDER: readonly BackgroundSection[] = [
	'shells',
	'monitors',
	'agents',
	'timers',
	'completed',
]

export type BackgroundRow =
	| {
			readonly kind: 'job'
			/** `job:<id>`, so a command and an agent can never share a key. */
			readonly key: string
			readonly section: 'shells' | 'monitors'
			readonly job: BackgroundJob
	  }
	| {
			readonly kind: 'agent'
			readonly key: string
			readonly section: 'agents' | 'completed'
			readonly agent: SubagentActivity
	  }
	| {
			/** A timer the model set; it waits in memory and can be cancelled. */
			readonly kind: 'timer'
			readonly key: string
			readonly section: 'timers'
			readonly timer: SessionTimer
	  }

export const jobKey = (id: string): string => `job:${id}`
export const timerKey = (id: string): string => `timer:${id}`
export const agentKey = (viewId: string): string => `agent:${viewId}`

/** Whether `x` can stop this row now. */
export function isRowRunning(row: BackgroundRow): boolean {
	if (row.kind === 'timer') return true
	return row.kind === 'job' ? row.job.status === 'running' : isRunning(row.agent)
}

/**
 * The dialog's rows, grouped in a fixed order: Shells, Monitors, Local agents,
 * Completed. Subagents that belong to a workflow are the workflow's rows, not
 * these.
 */
export function backgroundRows(
	jobs: readonly BackgroundJob[],
	agents: readonly SubagentActivity[],
	timers: readonly SessionTimer[] = [],
): readonly BackgroundRow[] {
	const rows: BackgroundRow[] = []
	for (const job of jobs) {
		rows.push({
			kind: 'job',
			key: jobKey(job.id),
			section: job.kind === 'monitor' ? 'monitors' : 'shells',
			job,
		})
	}
	const own = agents
		.filter((agent) => agent.workflow === DEFAULT_AGENT_WORKFLOW)
		.sort((a, b) => a.startedAt - b.startedAt)
	for (const agent of own) {
		rows.push({
			kind: 'agent',
			key: agentKey(agent.viewId),
			section: isRunning(agent) ? 'agents' : 'completed',
			agent,
		})
	}
	for (const timer of timers) {
		rows.push({ kind: 'timer', key: timerKey(timer.id), section: 'timers', timer })
	}
	return SECTION_ORDER.flatMap((section) => rows.filter((row) => row.section === section))
}

export function rowLabel(row: BackgroundRow): string {
	if (row.kind === 'timer') return row.timer.prompt
	if (row.kind === 'agent') return launchLabel(row.agent)
	return row.job.kind === 'monitor' ? (row.job.description ?? row.job.command) : row.job.command
}

export type RowMeta = 'running' | 'done' | 'error' | 'stopped' | 'failed' | 'killed' | 'waiting'

export function rowMeta(row: BackgroundRow): RowMeta {
	if (row.kind === 'timer') return 'waiting'
	if (row.kind === 'agent') {
		switch (row.agent.status) {
			case 'completed':
				return 'done'
			case 'failed':
				return 'failed'
			case 'cancelled':
				return 'killed'
			case 'queued':
				return 'waiting'
			default:
				return 'running'
		}
	}
	const { job } = row
	if (job.status === 'running') return 'running'
	if (job.status === 'killed') return 'stopped'
	return job.exitCode === 0 ? 'done' : 'error'
}

export interface BackgroundCounts {
	readonly shells: number
	readonly agents: number
	readonly timers?: number
}

/** The subtitle's numbers: running commands and running subagents. */
export function backgroundCounts(rows: readonly BackgroundRow[]): BackgroundCounts {
	return {
		shells: rows.filter((r) => r.section === 'shells' && isRowRunning(r)).length,
		agents: rows.filter((r) => r.section === 'agents').length,
		timers: rows.filter((r) => r.section === 'timers').length,
	}
}

/** `1 active shell · 2 active agents`; only the non-zero parts, empty when nothing runs. */
export function backgroundSubtitle(counts: BackgroundCounts): string {
	return [
		...(counts.shells > 0
			? [`${counts.shells} active ${counts.shells === 1 ? 'shell' : 'shells'}`]
			: []),
		...(counts.agents > 0
			? [`${counts.agents} active ${counts.agents === 1 ? 'agent' : 'agents'}`]
			: []),
		...((counts.timers ?? 0) > 0
			? [`${counts.timers} ${counts.timers === 1 ? 'timer' : 'timers'}`]
			: []),
	].join(' · ')
}

/** The time left until `iso`, as a person reads it: `45s`, `3m`, `1h 5m`, `2d`; `now` once due. */
export function timeLeft(iso: string | undefined, now: number): string {
	const at = iso ? Date.parse(iso) : Number.NaN
	if (Number.isNaN(at)) return ''
	const seconds = Math.ceil((at - now) / 1000)
	if (seconds <= 0) return 'now'
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.ceil(seconds / 60)
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
	return `${Math.floor(hours / 24)}d`
}

/** What a row says at its right edge: its state word, or for a timer the time left. */
export function rowTail(row: BackgroundRow, now: number): string {
	if (row.kind !== 'timer') return rowMeta(row)
	const left = timeLeft(row.timer.nextFireAt, now)
	const when = left === 'now' || left === '' ? 'due' : `in ${left}`
	return row.timer.recurring ? `↻ ${when}` : when
}
