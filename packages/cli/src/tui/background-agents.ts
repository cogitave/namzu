/**
 * The conversation while background agents outlive the turn that launched them,
 * as plain data (REFERENCE.md sections 2, 3, 5 and 8).
 *
 * The turn ends when the model has answered. What is still running is named on
 * one dim line until it ends, then the turn's closing line is written with the
 * wait included. A finished agent wakes the model once for everything that
 * ended meanwhile; Ctrl+C with nothing else to stop ends the agents with one
 * note to the model.
 */

import {
	DEFAULT_AGENT_WORKFLOW,
	type SubagentActivity,
} from '../integrations/subagents/activity.js'
import { launchLabel } from './agent-transcript-rows.js'
import { formatCompactCount } from './units.js'

/** Whether an agent has not ended. */
export function isRunning(agent: SubagentActivity): boolean {
	return agent.status === 'starting' || agent.status === 'queued' || agent.status === 'working'
}

/** The background agents a turn closed over: running, and not a workflow's. */
export function pendingBackgroundAgents(
	agents: readonly SubagentActivity[],
	isWorkflowAgent: (agent: SubagentActivity) => boolean,
): readonly SubagentActivity[] {
	return agents.filter(
		(agent) =>
			agent.replayed !== true &&
			agent.background === true &&
			isRunning(agent) &&
			!isWorkflowAgent(agent),
	)
}

/**
 * `Waiting for 2 background agents to finish`, or with workflows
 * `Waiting for 1 background agent and 2 dynamic workflows to finish`; undefined
 * when nothing is pending (the reference's turn row, `Dg`).
 */
export function backgroundWaitLine(agents: number, workflows: number): string | undefined {
	if (agents <= 0 && workflows <= 0) return undefined
	const parts = [
		...(agents > 0 ? [`${agents} background ${agents === 1 ? 'agent' : 'agents'}`] : []),
		...(workflows > 0
			? [`${workflows} dynamic ${workflows === 1 ? 'workflow' : 'workflows'}`]
			: []),
	]
	return `Waiting for ${parts.join(' and ')} to finish`
}

/**
 * The note the model reads when the operator stops background agents from an
 * idle composer: one note, however many (the reference's task notification).
 */
export function stoppedByUserNote(descriptions: readonly string[]): string | undefined {
	const names = descriptions.map((value) => value.replace(/\s+/gu, ' ').trim()).filter(Boolean)
	if (names.length === 0) return undefined
	if (names.length === 1) return `Background agent "${names[0]}" was stopped by the user.`
	return `${names.length} background agents were stopped by the user: ${names
		.map((name) => `"${name}"`)
		.join(', ')}.`
}

export interface RunningGroup {
	/** `Running 3 agents…` */
	readonly header: string
	/** Per agent: its line, then the status line beneath it. */
	readonly agents: readonly { readonly line: string; readonly status: string }[]
}

/**
 * The live group for a batch that includes an agent the turn waits on:
 * `Running 3 agents…`, then per agent `description · 4 tool uses · 12.1k tokens`
 * over `⎿ <last tool>` (REA fn Ym; `Initializing…` before the first tool).
 * Undefined when every member runs in the background or has ended: that batch is
 * the launch receipt, not a live group.
 */
export function runningGroup(members: readonly SubagentActivity[]): RunningGroup | undefined {
	const live = members.filter((agent) => agent.replayed !== true)
	if (live.length === 0 || live.some((agent) => agent.background === true)) return undefined
	if (!live.some(isRunning)) return undefined
	// A labelled workflow is one piece of work with its own rail row, not agents.
	if (live.some((agent) => agent.workflow !== DEFAULT_AGENT_WORKFLOW)) return undefined
	return {
		header: `Running ${live.length} ${live.length === 1 ? 'agent' : 'agents'}…`,
		agents: live.map((agent) => {
			const uses = agent.toolCalls ?? 0
			const parts = [
				launchLabel(agent),
				`${uses} tool ${uses === 1 ? 'use' : 'uses'}`,
				...(agent.tokens !== undefined ? [`${formatCompactCount(agent.tokens)} tokens`] : []),
			]
			const last = agent.latestActivity?.replace(/\s+/gu, ' ').trim()
			return {
				line: parts.join(' · '),
				status: isRunning(agent) ? (last && last.length > 0 ? last : 'Initializing…') : 'Done',
			}
		}),
	}
}

/** The live groups on screen: one per batch the turn is waiting on, oldest first. */
export function liveGroups(
	agents: readonly SubagentActivity[],
	isWorkflowAgent: (agent: SubagentActivity) => boolean,
): readonly RunningGroup[] {
	const batches = new Map<string, SubagentActivity[]>()
	for (const agent of agents) {
		if (agent.replayed === true || agent.resumed === true || isWorkflowAgent(agent)) continue
		const key = JSON.stringify([agent.workflowId, agent.batchId])
		const members = batches.get(key) ?? []
		members.push(agent)
		batches.set(key, members)
	}
	return [...batches.values()]
		.map((members) => [...members].sort((a, b) => a.startedAt - b.startedAt))
		.sort((a, b) => (a[0]?.startedAt ?? 0) - (b[0]?.startedAt ?? 0))
		.flatMap((members) => {
			const group = runningGroup(members)
			return group ? [group] : []
		})
}
