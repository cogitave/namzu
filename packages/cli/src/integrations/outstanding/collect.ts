/**
 * One liveness record for every running item of a session: background jobs,
 * monitors, delegated agents and workflow runs.
 *
 * Pure over what it is given. The caller supplies the clock and the facts it
 * read (the job registry's records and its process probe, the agent monitor's
 * snapshot, the workflow registry's views), and the verdict comes from the
 * kernel's `judgeLiveness`, so the note the model is shown on every request
 * and the lines the status reads return are the same words.
 */

import { LIVENESS_QUIET_MS, type Liveness, type LivenessInput, judgeLiveness } from '@namzu/sdk'

import type { SubagentActivity } from '../subagents/activity.js'
import { type WorkflowRunView, countAgents } from '../workflows/view.js'

/** A job or monitor as the registry holds it, with its process probe already asked. */
export interface JobFact {
	readonly id: string
	readonly command: string
	readonly description?: string
	readonly kind?: 'monitor'
	readonly status: 'running' | 'exited' | 'killed'
	readonly startedAt: number
	readonly lastOutputAt?: number
	readonly lastOutputLine?: string
	readonly alive: boolean
}

export interface OutstandingFacts {
	readonly now: number
	readonly jobs: readonly JobFact[]
	readonly agents: readonly SubagentActivity[]
	readonly workflows: readonly WorkflowRunView[]
	/** The id the model sees for an agent; defaults to its task id. */
	readonly agentId?: (agent: SubagentActivity) => string
}

const TERMINAL: ReadonlySet<SubagentActivity['status']> = new Set([
	'completed',
	'failed',
	'cancelled',
])

/** The tool name of a transcript row such as `Read(file.ts)`: the row's text up to its argument. */
function toolName(text: string): string {
	return text.split(/[\s(]/, 1)[0] ?? text
}

/** A short, deterministic label of what an agent is doing: no model call, only what the monitor saw. */
export function agentProgressLabel(agent: SubagentActivity): string | undefined {
	if (agent.status === 'queued') return 'queued for a free slot'
	if (agent.summary) return agent.summary
	const last = agent.transcript.at(-1)
	if (last?.kind === 'tool')
		return `${last.status === 'working' ? 'running' : 'ran'} ${toolName(last.text)}`
	return agent.latestActivity
}

function agentInput(agent: SubagentActivity, now: number, id: string): LivenessInput {
	const last = agent.transcript.at(-1)
	const lastProgressAt = agent.lastProgressAt ?? agent.startedAt
	const where = agentProgressLabel(agent)
	const inTool = last?.kind === 'tool' && last.status === 'working'
	const queued = agent.status === 'queued'
	const quietLongEnough = now - lastProgressAt >= LIVENESS_QUIET_MS
	return {
		kind: 'agent',
		id,
		label: agent.description,
		...(where !== undefined ? { where } : {}),
		startedAt: agent.startedAt,
		lastProgressAt,
		alive: !TERMINAL.has(agent.status),
		finished: agent.status === 'completed',
		...(queued
			? { waitingOn: 'a free agent slot', waitingSince: agent.startedAt }
			: inTool && quietLongEnough
				? { waitingOn: `the ${toolName(last.text)} tool`, waitingSince: lastProgressAt }
				: {}),
	}
}

/** The phase a run is in: the latest phase any running agent belongs to, else the latest agent's. */
export function currentPhase(
	view: WorkflowRunView,
): { readonly index: number; readonly total: number; readonly title: string } | undefined {
	const total = view.phases.length
	const running = view.agents.filter((agent) => agent.status === 'running')
	const pool =
		running.length > 0 ? running : view.agents.filter((agent) => agent.status !== 'queued')
	let best: { index: number; title: string } | undefined
	for (const agent of pool) {
		if (agent.phaseIndex === undefined) continue
		if (!best || agent.phaseIndex > best.index)
			best = { index: agent.phaseIndex, title: agent.phaseTitle ?? '' }
	}
	if (!best) return undefined
	const known = view.phases.find((phase) => phase.index === best?.index)
	return {
		index: best.index,
		total: Math.max(total, best.index),
		title: known?.title ?? best.title,
	}
}

/** The most recent thing any part of a run did, from the agents' own times and their live rows. */
export function workflowLastProgressAt(
	view: WorkflowRunView,
	snapshot: readonly SubagentActivity[],
): number {
	let latest = view.startedAt
	const byView = new Map(snapshot.map((entry) => [entry.viewId, entry]))
	for (const agent of view.agents) {
		latest = Math.max(latest, agent.queuedAt, agent.startedAt ?? 0, agent.finishedAt ?? 0)
		const live = agent.viewId === undefined ? undefined : byView.get(agent.viewId)
		if (live?.lastProgressAt !== undefined) latest = Math.max(latest, live.lastProgressAt)
	}
	return latest
}

function workflowWhere(view: WorkflowRunView): string {
	const counts = countAgents(view)
	const phase = currentPhase(view)
	const where = phase
		? `phase ${phase.index}/${phase.total}${phase.title ? ` "${phase.title}"` : ''}, `
		: ''
	return `${where}${counts.running} running, ${counts.queued} queued, ${counts.done} done${counts.failed > 0 ? `, ${counts.failed} failed` : ''}`
}

function workflowInput(
	view: WorkflowRunView,
	snapshot: readonly SubagentActivity[],
): LivenessInput {
	const counts = countAgents(view)
	return {
		kind: 'workflow',
		id: view.runId,
		label: view.name,
		where: workflowWhere(view),
		startedAt: view.startedAt,
		lastProgressAt: workflowLastProgressAt(view, snapshot),
		alive: view.status === 'running',
		finished: view.status !== 'running',
		// Everything asked for is waiting for a slot: that is a reason, not a stall.
		...(counts.running === 0 && counts.queued > 0 ? { waitingOn: 'a free agent slot' } : {}),
	}
}

function jobInput(job: JobFact): LivenessInput {
	const monitor = job.kind === 'monitor'
	return {
		kind: monitor ? 'monitor' : 'job',
		id: job.id,
		label: monitor ? (job.description ?? job.command) : job.command,
		...(job.lastOutputLine !== undefined ? { where: job.lastOutputLine } : {}),
		startedAt: job.startedAt,
		...(job.lastOutputAt !== undefined ? { lastProgressAt: job.lastOutputAt } : {}),
		alive: job.alive,
		finished: job.status !== 'running',
		// A monitor is quiet until the thing it watches happens: that is its job.
		...(monitor
			? { waitingOn: 'new events', waitingSince: job.lastOutputAt ?? job.startedAt }
			: {}),
	}
}

/**
 * The running items, workflows first, then agents, jobs and monitors, each
 * group oldest first. Ended items are not outstanding and are left out; an
 * item the registry still lists as running whose probe says it is gone stays,
 * as `dead`, so the model can say so instead of waiting for it.
 */
export function collectOutstanding(facts: OutstandingFacts): readonly Liveness[] {
	const { now } = facts
	const snapshot = facts.agents
	const out: Array<{ readonly at: number; readonly group: number; readonly item: Liveness }> = []
	for (const view of facts.workflows) {
		if (view.status !== 'running') continue
		out.push({
			at: view.startedAt,
			group: 0,
			item: judgeLiveness(workflowInput(view, snapshot), now),
		})
	}
	for (const agent of snapshot) {
		// A workflow run's agents are told as part of the run.
		if (agent.workflowRunId !== undefined || agent.replayed || TERMINAL.has(agent.status)) continue
		const id = facts.agentId?.(agent) ?? agent.taskId ?? agent.viewId
		out.push({
			at: agent.startedAt,
			group: 1,
			item: judgeLiveness(agentInput(agent, now, id), now),
		})
	}
	for (const job of facts.jobs) {
		if (job.status !== 'running') continue
		out.push({
			at: job.startedAt,
			group: job.kind === 'monitor' ? 3 : 2,
			item: judgeLiveness(jobInput(job), now),
		})
	}
	return out.sort((a, b) => a.group - b.group || a.at - b.at).map((entry) => entry.item)
}
