/**
 * What the terminal knows about one workflow run, as plain data.
 *
 * A run is folded from the SDK's workflow events (and, for a run from an
 * earlier process, from its journal), so the rail, the detail view and the
 * `/workflows` list all read one shape and none of them runs the script.
 * Pure: no timers, no I/O.
 */

import type {
	WorkflowEvent,
	WorkflowJournalRecord,
	WorkflowPhaseMeta,
	WorkflowUsage,
} from '@namzu/sdk'

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'stopped'

export type WorkflowAgentStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped'

export interface WorkflowAgentView {
	/** 1-based, in the order the script asked. */
	readonly index: number
	readonly label: string
	readonly phaseIndex?: number
	readonly phaseTitle?: string
	readonly agentType?: string
	readonly model?: string
	readonly status: WorkflowAgentStatus
	readonly queuedAt: number
	readonly startedAt?: number
	readonly finishedAt?: number
	readonly tokens: number
	readonly toolCalls: number
	readonly lastTool?: string
	readonly promptPreview?: string
	readonly resultPreview?: string
	readonly error?: string
	/** The agent's own row in the subagent monitor, once it exists. */
	readonly viewId?: string
}

export interface WorkflowPhaseView {
	/** 1-based first-seen order; declared titles come first. */
	readonly index: number
	readonly title: string
	readonly detail?: string
	readonly declared: boolean
}

export interface WorkflowRunView {
	readonly runId: string
	/** The id the run's agents carry as their `workflowId` in the monitor. */
	readonly workflowId: string
	/** The display group the cockpit and the rail use for this run. */
	readonly groupId: string
	readonly name: string
	readonly description: string
	readonly status: WorkflowRunStatus
	readonly startedAt: number
	readonly endedAt?: number
	readonly phases: readonly WorkflowPhaseView[]
	readonly agents: readonly WorkflowAgentView[]
	/** The last few `log()` lines, newest last. */
	readonly logs: readonly string[]
	readonly error?: string
	readonly result?: unknown
	readonly usage?: WorkflowUsage
}

const MAX_LOG_LINES = 5

/** The monitor's `workflowId` for a run's agents. */
export function workflowRunWorkflowId(runId: string): string {
	return `wf:${runId}`
}

/** The display group id for a run. */
export function workflowRunGroupId(runId: string): string {
	return `wfrun:${runId}`
}

/** Whether a monitor row belongs to a workflow run (as opposed to an `Agent` tool call). */
export function isWorkflowRunAgent(agent: {
	readonly workflowId: string
}): boolean {
	return agent.workflowId.startsWith('wf:')
}

export function initialRunView(input: {
	readonly runId: string
	readonly name: string
	readonly description: string
	readonly phases: readonly WorkflowPhaseMeta[]
	readonly at: number
}): WorkflowRunView {
	return {
		runId: input.runId,
		workflowId: workflowRunWorkflowId(input.runId),
		groupId: workflowRunGroupId(input.runId),
		name: input.name,
		description: input.description,
		status: 'running',
		startedAt: input.at,
		phases: input.phases.map((phase, index) => ({
			index: index + 1,
			title: phase.title,
			...(phase.detail !== undefined ? { detail: phase.detail } : {}),
			declared: true,
		})),
		agents: [],
		logs: [],
	}
}

function withAgent(view: WorkflowRunView, next: WorkflowAgentView): WorkflowRunView {
	const at = view.agents.findIndex((agent) => agent.index === next.index)
	const agents =
		at < 0
			? [...view.agents, next].sort((a, b) => a.index - b.index)
			: [...view.agents.slice(0, at), next, ...view.agents.slice(at + 1)]
	return { ...view, agents }
}

function withPhase(view: WorkflowRunView, phase: WorkflowPhaseView): WorkflowRunView {
	const known = view.phases.find((item) => item.index === phase.index)
	if (known) return view
	return {
		...view,
		phases: [...view.phases, phase].sort((a, b) => a.index - b.index),
	}
}

/** The last tool row's label becomes the progress line. */
function toolSummary(name: string | undefined, summary: string | undefined): string | undefined {
	if (summary) return summary
	return name
}

/**
 * An agent the runtime closed because the run was stopped is an agent that did
 * not get to run, not one that failed: the operator's Stop must not read as
 * errors. The runtime words these two cases the same way every time.
 */
function stoppedWithTheRun(error: string | undefined): boolean {
	return (
		error !== undefined &&
		/^The workflow was stopped before this agent (started|finished)\./.test(error)
	)
}

/** Fold one SDK event into the run. Events of another run are ignored. */
export function reduceRunView(view: WorkflowRunView, event: WorkflowEvent): WorkflowRunView {
	if (event.runId !== view.runId) return view
	switch (event.type) {
		case 'workflow_started':
			return view
		case 'workflow_phase': {
			const known = view.phases.find((item) => item.index === event.index)
			if (known) return view
			return withPhase(view, {
				index: event.index,
				title: event.title,
				declared: event.declared,
			})
		}
		case 'workflow_agent': {
			const previous = view.agents.find((agent) => agent.index === event.index)
			const status: WorkflowAgentStatus =
				event.state === 'error'
					? stoppedWithTheRun(event.error)
						? 'skipped'
						: 'failed'
					: event.state === 'done'
						? event.skipped
							? 'skipped'
							: 'done'
						: event.startedAt === undefined
							? 'queued'
							: 'running'
			const lastTool = toolSummary(event.lastToolName, event.lastToolSummary) ?? previous?.lastTool
			return withAgent(view, {
				index: event.index,
				label: event.label,
				...(event.phaseIndex !== undefined ? { phaseIndex: event.phaseIndex } : {}),
				...(event.phaseTitle !== undefined ? { phaseTitle: event.phaseTitle } : {}),
				...(event.agentType !== undefined ? { agentType: event.agentType } : {}),
				...(event.model !== undefined ? { model: event.model } : {}),
				status,
				queuedAt: event.queuedAt,
				...(event.startedAt !== undefined ? { startedAt: event.startedAt } : {}),
				...(event.finishedAt !== undefined ? { finishedAt: event.finishedAt } : {}),
				tokens: event.tokens,
				toolCalls: event.toolCalls,
				...(lastTool !== undefined ? { lastTool } : {}),
				promptPreview: event.promptPreview,
				...(event.resultPreview !== undefined ? { resultPreview: event.resultPreview } : {}),
				...(event.error !== undefined ? { error: event.error } : {}),
				...(previous?.viewId !== undefined ? { viewId: previous.viewId } : {}),
			})
		}
		case 'workflow_log':
			return {
				...view,
				logs: [...view.logs, event.message].slice(-MAX_LOG_LINES),
			}
		case 'workflow_finished':
			return {
				...view,
				status: event.status,
				endedAt: event.at,
				...(event.error !== undefined ? { error: event.error } : {}),
				...(event.result !== undefined ? { result: event.result } : {}),
				usage: event.usage,
			}
	}
}

/** Record which monitor row is an agent's own, so the detail can open its transcript. */
export function attachAgentView(
	view: WorkflowRunView,
	index: number,
	viewId: string,
): WorkflowRunView {
	const agent = view.agents.find((item) => item.index === index)
	if (!agent || agent.viewId === viewId) return view
	return withAgent(view, { ...agent, viewId })
}

/** The run ended while agents were still listed as going (a crash or a stop): close them. */
export function closeOpenAgents(view: WorkflowRunView, at: number): WorkflowRunView {
	let next = view
	for (const agent of view.agents) {
		if (agent.status === 'queued' || agent.status === 'running') {
			next = withAgent(next, {
				...agent,
				status: 'skipped',
				finishedAt: agent.finishedAt ?? at,
			})
		}
	}
	return next
}

export interface WorkflowAgentCounts {
	readonly total: number
	readonly settled: number
	readonly failed: number
	readonly running: number
	readonly queued: number
}

export function countAgents(view: Pick<WorkflowRunView, 'agents'>): WorkflowAgentCounts {
	let settled = 0
	let failed = 0
	let running = 0
	let queued = 0
	for (const agent of view.agents) {
		if (agent.status === 'queued') queued += 1
		else if (agent.status === 'running') running += 1
		else {
			settled += 1
			if (agent.status === 'failed') failed += 1
		}
	}
	return { total: view.agents.length, settled, failed, running, queued }
}

export function runTokens(view: Pick<WorkflowRunView, 'agents'>): number {
	return view.agents.reduce((sum, agent) => sum + agent.tokens, 0)
}

/**
 * Rebuild a run from its journal, for a run this process did not start. Lines
 * that are not records are skipped; the result is whatever the file proves.
 */
export function viewFromJournal(
	records: readonly WorkflowJournalRecord[],
): WorkflowRunView | undefined {
	const started = records.find((record) => record.type === 'run_started')
	if (!started || started.type !== 'run_started') return undefined
	let view = initialRunView({
		runId: started.runId,
		name: started.meta.name,
		description: started.meta.description,
		phases: started.meta.phases,
		at: started.at,
	})
	for (const record of records) {
		switch (record.type) {
			case 'phase':
				view = withPhase(view, {
					index: record.index,
					title: record.title,
					declared: record.declared,
				})
				break
			case 'agent_request':
				view = withAgent(view, {
					index: record.index,
					label: record.label,
					...(record.phaseIndex !== undefined ? { phaseIndex: record.phaseIndex } : {}),
					...(record.phaseTitle !== undefined ? { phaseTitle: record.phaseTitle } : {}),
					...(record.options.agentType !== undefined
						? { agentType: record.options.agentType }
						: {}),
					...(record.options.model !== undefined ? { model: record.options.model } : {}),
					status: 'queued',
					queuedAt: record.at,
					tokens: 0,
					toolCalls: 0,
					promptPreview: record.promptPreview,
				})
				break
			case 'agent_outcome': {
				const agent = view.agents.find((item) => item.index === record.index)
				if (!agent) break
				view = withAgent(view, {
					...agent,
					status:
						record.state === 'error'
							? stoppedWithTheRun(record.error)
								? 'skipped'
								: 'failed'
							: record.state === 'skipped'
								? 'skipped'
								: 'done',
					...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
					finishedAt: record.finishedAt,
					tokens: record.tokens,
					toolCalls: record.toolCalls,
					...(record.resultPreview !== undefined ? { resultPreview: record.resultPreview } : {}),
					...(record.error !== undefined ? { error: record.error } : {}),
				})
				break
			}
			case 'log':
				view = {
					...view,
					logs: [...view.logs, record.message].slice(-MAX_LOG_LINES),
				}
				break
			case 'run_finished':
				view = {
					...view,
					status: record.status,
					endedAt: record.at,
					...(record.error !== undefined ? { error: record.error } : {}),
					...(record.result !== undefined ? { result: record.result } : {}),
					usage: record.usage,
				}
				break
			default:
				break
		}
	}
	// A journal that stops before `run_finished` is a run that died with its process.
	if (view.status === 'running') {
		const last = records.at(-1)
		view = closeOpenAgents(
			{
				...view,
				status: 'stopped',
				endedAt: last?.at ?? started.at,
				error: 'The session ended before this workflow finished.',
			},
			last?.at ?? started.at,
		)
	}
	return view
}
