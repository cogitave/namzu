/**
 * The conversation while background agents outlive the turn that launched them,
 * as plain data.
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
import { type LiveCalls, liveCalls } from './agent-calls.js'
import { AGENT_MANAGE_HINT, launchLabel } from './agent-transcript-rows.js'
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
 * when nothing is pending.
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
 * idle composer: one note, however many.
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
	readonly agents: readonly {
		readonly line: string
		readonly status: string
		/** Its last calls, when it is the only agent waited on and the window has room. */
		readonly calls?: LiveCalls
	}[]
}

/**
 * The most rows one agent's calls add to the live group: the line saying how
 * many earlier calls are not shown, and the last three. They stand in for the
 * single status row, so the block is this many rows taller than the one-line
 * form.
 */
export const CALL_BLOCK_EXTRA_ROWS = 3

/**
 * The live group for a batch that includes an agent the turn waits on:
 * `Running 3 agents…`, then per agent `description · 4 tool uses · 12.1k tokens`
 * over `⎿ <last tool>` (`Initializing…` before the first tool).
 * Undefined when every member runs in the background or has ended: that batch is
 * the launch receipt, not a live group.
 */
export function runningGroup(
	members: readonly SubagentActivity[],
	/** Draw the agent's last calls under it (one agent waited on, room to spare). */
	withCalls = false,
): RunningGroup | undefined {
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
			const calls = withCalls && isRunning(agent) ? liveCalls(agent, AGENT_MANAGE_HINT) : undefined
			return {
				line: parts.join(' · '),
				status: isRunning(agent) ? (last && last.length > 0 ? last : 'Initializing…') : 'Done',
				...(calls ? { calls } : {}),
			}
		}),
	}
}

/** The live groups on screen: one per batch the turn is waiting on, oldest first. */
export function liveGroups(
	agents: readonly SubagentActivity[],
	isWorkflowAgent: (agent: SubagentActivity) => boolean,
	/**
	 * Whether the window has room for an agent's calls. They are drawn only for
	 * ONE agent waited on: with several, each keeps its one line and its latest
	 * activity, because three calls per agent would be taller than the region.
	 */
	roomForCalls = false,
): readonly RunningGroup[] {
	const batches = new Map<string, SubagentActivity[]>()
	for (const agent of agents) {
		if (agent.replayed === true || agent.resumed === true || isWorkflowAgent(agent)) continue
		const key = JSON.stringify([agent.workflowId, agent.batchId])
		const members = batches.get(key) ?? []
		members.push(agent)
		batches.set(key, members)
	}
	const sorted = [...batches.values()]
		.map((members) => [...members].sort((a, b) => a.startedAt - b.startedAt))
		.sort((a, b) => (a[0]?.startedAt ?? 0) - (b[0]?.startedAt ?? 0))
	const plain = sorted.flatMap((members) => {
		const group = runningGroup(members)
		return group ? [group] : []
	})
	const waitedOn = plain.reduce((sum, group) => sum + group.agents.length, 0)
	if (!roomForCalls || waitedOn !== 1) return plain
	return sorted.flatMap((members) => {
		const group = runningGroup(members, true)
		return group ? [group] : []
	})
}

/** The rows a live group adds beyond its one-line form: zero unless an agent's calls are drawn. */
export function callBlockExtraRows(groups: readonly RunningGroup[]): number {
	let extra = 0
	for (const group of groups) {
		for (const agent of group.agents) {
			if (!agent.calls) continue
			// The calls replace the one status row.
			extra += agent.calls.rows.length + (agent.calls.earlier ? 1 : 0) - 1
		}
	}
	return extra
}
