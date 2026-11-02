/**
 * What the Background dialog lists, as plain data.
 *
 * One list for everything running behind the conversation: background
 * commands, monitors and the subagents of this conversation. Subagents that
 * have ended move to their own section; commands and monitors stay in theirs
 * with an ended word until the session closes.
 */

import type { BackgroundJob } from '@namzu/sdk'
import {
	DEFAULT_AGENT_WORKFLOW,
	type SubagentActivity,
} from '../integrations/subagents/activity.js'
import { launchLabel } from './agent-transcript-rows.js'
import { isRunning } from './background-agents.js'

export type BackgroundSection = 'shells' | 'monitors' | 'agents' | 'completed'

export const BACKGROUND_SECTION_TITLES: Readonly<Record<BackgroundSection, string>> = {
	shells: 'Shells',
	monitors: 'Monitors',
	agents: 'Local agents',
	completed: 'Completed',
}

const SECTION_ORDER: readonly BackgroundSection[] = ['shells', 'monitors', 'agents', 'completed']

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

export const jobKey = (id: string): string => `job:${id}`
export const agentKey = (viewId: string): string => `agent:${viewId}`

/** Whether `x` can stop this row now. */
export function isRowRunning(row: BackgroundRow): boolean {
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
	return SECTION_ORDER.flatMap((section) => rows.filter((row) => row.section === section))
}

export function rowLabel(row: BackgroundRow): string {
	if (row.kind === 'agent') return launchLabel(row.agent)
	return row.job.kind === 'monitor' ? (row.job.description ?? row.job.command) : row.job.command
}

export type RowMeta = 'running' | 'done' | 'error' | 'stopped' | 'failed' | 'killed' | 'waiting'

export function rowMeta(row: BackgroundRow): RowMeta {
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
}

/** The subtitle's numbers: running commands and running subagents. */
export function backgroundCounts(rows: readonly BackgroundRow[]): BackgroundCounts {
	return {
		shells: rows.filter((r) => r.section === 'shells' && isRowRunning(r)).length,
		agents: rows.filter((r) => r.section === 'agents').length,
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
	].join(' · ')
}
