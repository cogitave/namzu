/**
 * A workflow run, as the rows the rail and the detail view draw.
 *
 * The run's own record (`WorkflowRunView`) knows every agent the script asked
 * for, including the ones still queued, and every declared phase, including
 * the ones nothing has started in. The subagent monitor knows the children
 * that actually started, with their transcripts. This joins the two into the
 * `SubagentActivity` rows the existing screens already read, so a workflow's
 * agents are listed and opened exactly like any other child but are never
 * rows of the agents rail: they carry the run's `workflowId` and the rail
 * filters them out by it. Pure.
 */

import {
	DEFAULT_AGENT_PHASE,
	type SubagentActivity,
	type SubagentActivityStatus,
} from '../integrations/subagents/activity.js'
import {
	type WorkflowAgentStatus,
	type WorkflowRunView,
	countAgents,
	isWorkflowRunAgent,
	runTokens,
} from '../integrations/workflows/view.js'

/** The phase id the detail view uses for a phase index of a run. */
export function runPhaseId(
	run: Pick<WorkflowRunView, 'groupId'>,
	phaseIndex: number | undefined,
): string {
	return `${run.groupId}:p:${phaseIndex ?? 0}`
}

/** The row id of a queued agent that has no child yet. */
export function queuedAgentViewId(runId: string, index: number): string {
	return `wfq:${runId}:${index}`
}

const STATUS: Record<WorkflowAgentStatus, SubagentActivityStatus> = {
	queued: 'queued',
	running: 'working',
	done: 'completed',
	failed: 'failed',
	skipped: 'cancelled',
}

/** The rows of one run: its children where they exist, a stand-in where an agent has not started. */
export function projectRunAgents(
	run: WorkflowRunView,
	children: ReadonlyMap<string, SubagentActivity>,
): readonly SubagentActivity[] {
	return run.agents.map((agent) => {
		const child = agent.viewId !== undefined ? children.get(agent.viewId) : undefined
		const phase = run.phases.find((item) => item.index === agent.phaseIndex)
		const row: SubagentActivity = {
			viewId: child?.viewId ?? queuedAgentViewId(run.runId, agent.index),
			...(child?.taskId ? { taskId: child.taskId } : {}),
			...(child?.sessionId ? { sessionId: child.sessionId } : {}),
			agentId: agent.agentType ?? child?.agentId ?? 'general-purpose',
			...((agent.model ?? child?.model) ? { model: (agent.model ?? child?.model) as string } : {}),
			...(agent.tokens > 0 || child?.tokens !== undefined
				? { tokens: Math.max(agent.tokens, child?.tokens ?? 0) }
				: {}),
			...(agent.toolCalls > 0 || child?.toolCalls !== undefined
				? { toolCalls: Math.max(agent.toolCalls, child?.toolCalls ?? 0) }
				: {}),
			description: agent.label,
			prompt: child?.prompt ?? agent.promptPreview ?? '',
			batchId: run.runId,
			workflowId: run.workflowId,
			workflowGroupId: run.groupId,
			phaseId: runPhaseId(run, agent.phaseIndex),
			workflow: run.name,
			phase: agent.phaseTitle ?? DEFAULT_AGENT_PHASE,
			...(agent.phaseIndex !== undefined ? { phaseOrder: agent.phaseIndex } : {}),
			...(phase?.detail !== undefined ? { phaseDetail: phase.detail } : {}),
			phaseSequence: agent.phaseIndex ?? 0,
			status: STATUS[agent.status],
			startedAt: agent.startedAt ?? agent.queuedAt,
			...(agent.finishedAt !== undefined ? { completedAt: agent.finishedAt } : {}),
			...((agent.lastTool ?? child?.latestActivity)
				? { latestActivity: (agent.lastTool ?? child?.latestActivity) as string }
				: {}),
			transcript: child?.transcript ?? [],
			workflowRunId: run.runId,
			workflowAgentIndex: agent.index,
		}
		return row
	})
}

/**
 * What the screens read: the monitor's rows with the workflow children
 * replaced by their runs' rows. A child whose run is gone from `runs` is
 * dropped, not shown as a stray agent.
 */
export function withWorkflowRuns(
	agents: readonly SubagentActivity[],
	runs: readonly WorkflowRunView[],
): readonly SubagentActivity[] {
	if (runs.length === 0 && !agents.some(isWorkflowRunAgent)) return agents
	const children = new Map(agents.filter(isWorkflowRunAgent).map((agent) => [agent.viewId, agent]))
	return [
		...agents.filter((agent) => !isWorkflowRunAgent(agent)),
		...runs.flatMap((run) => projectRunAgents(run, children)),
	]
}

/** Runs that are still going or ended less than `lingerMs` ago, oldest first. */
export function visibleRuns(
	runs: readonly WorkflowRunView[],
	now: number,
	lingerMs: number,
	dismissed: ReadonlySet<string> = new Set(),
): readonly WorkflowRunView[] {
	return runs
		.filter(
			(run) =>
				!dismissed.has(`workflow:${run.groupId}`) &&
				(run.status === 'running' || (run.endedAt !== undefined && now - run.endedAt < lingerMs)),
		)
		.sort((a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId))
}

/** Milliseconds until the earliest ended run leaves the rail, or undefined. */
export function nextRunEviction(
	runs: readonly WorkflowRunView[],
	now: number,
	lingerMs: number,
): number | undefined {
	let soonest: number | undefined
	for (const run of runs) {
		if (run.status === 'running' || run.endedAt === undefined) continue
		const left = run.endedAt + lingerMs - now
		if (left > 0 && (soonest === undefined || left < soonest)) soonest = left
	}
	return soonest
}

export interface RunRailFacts {
	readonly done: number
	readonly total: number
	readonly failed: number
	readonly tokens: number | undefined
}

export function runRailFacts(run: WorkflowRunView): RunRailFacts {
	const counts = countAgents(run)
	const tokens = runTokens(run)
	return {
		done: counts.done,
		total: counts.total,
		failed: counts.failed,
		tokens: tokens > 0 ? tokens : undefined,
	}
}
