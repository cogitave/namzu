/**
 * A run of the `workflow` tool reaches the rail and the detail view from its
 * own events: queued agents count, declared phases show before anything has
 * started in them, and none of its agents is ever a subagent row.
 */

import { createRequire } from 'node:module'

import { Box } from 'ink'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import {
	type WorkflowAgentView,
	type WorkflowRunView,
	initialRunView,
} from '../../integrations/workflows/view.js'
import {
	AGENT_RAIL_FINISHED_LINGER_MS,
	AgentCockpit,
	AgentTaskPanel,
	AgentTranscript,
	agentWorkflows,
	cockpitEntryFocus,
	phaseCount,
	phaseOutcome,
	railAgents,
	railNextEviction,
	railWorkflows,
	runRailWorkflow,
} from '../AgentExplorer.js'
import { projectRunAgents, withWorkflowRuns } from '../workflow-runs.js'
import { type Screen, renderToScreen } from './support/screen.js'

const NOW = Date.now()

const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as {
	level: number
}
const originalColorLevel = chalk.level
beforeAll(() => {
	chalk.level = 0
})
afterAll(() => {
	chalk.level = originalColorLevel
})

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

function agentView(
	index: number,
	status: WorkflowAgentView['status'],
	extra: Partial<WorkflowAgentView> = {},
): WorkflowAgentView {
	return {
		index,
		label: `agent:${index}`,
		queuedAt: NOW - 20_000,
		tokens: 0,
		toolCalls: 0,
		status,
		...(status === 'running' || status === 'done' ? { startedAt: NOW - 15_000 } : {}),
		...(status === 'done' ? { finishedAt: NOW - 5_000 } : {}),
		...extra,
	}
}

/** `audit`: Scan declared first, Fix second; two scan agents, one done, one running; one fix queued. */
function run(overrides: Partial<WorkflowRunView> = {}): WorkflowRunView {
	return {
		...initialRunView({
			runId: 'wrun00001',
			name: 'audit',
			description: 'Scan, then fix',
			phases: [{ title: 'Scan' }, { title: 'Fix', detail: 'safe fixes only' }, { title: 'Report' }],
			at: NOW - 20_000,
		}),
		agents: [
			agentView(1, 'done', {
				phaseIndex: 1,
				phaseTitle: 'Scan',
				tokens: 1200,
				viewId: 'agent-1',
			}),
			agentView(2, 'running', {
				phaseIndex: 1,
				phaseTitle: 'Scan',
				tokens: 300,
				viewId: 'agent-2',
			}),
			agentView(3, 'queued', { phaseIndex: 2, phaseTitle: 'Fix' }),
		],
		...overrides,
	}
}

/** The monitor's own rows for the two children that started. */
function children(): SubagentActivity[] {
	const child = (viewId: string, text: string): SubagentActivity => ({
		viewId,
		agentId: 'general-purpose',
		description: viewId,
		prompt: `prompt of ${viewId}`,
		batchId: 'wrun00001',
		workflowId: 'wf:wrun00001',
		workflowGroupId: 'whatever-the-monitor-picked',
		phaseId: `monitor-phase-${viewId}`,
		workflow: 'audit',
		phase: 'Scan',
		phaseSequence: 1,
		status: 'working',
		startedAt: NOW - 15_000,
		transcript: [{ id: `${viewId}:a`, kind: 'assistant', text }],
	})
	return [child('agent-1', 'found nothing'), child('agent-2', 'still reading')]
}

describe('what a run projects', () => {
	it('lists every agent the script asked for, the queued ones with a stand-in row', () => {
		const rows = projectRunAgents(run(), new Map(children().map((c) => [c.viewId, c])))
		expect(rows.map((r) => [r.viewId, r.status, r.workflowRunId, r.workflowAgentIndex])).toEqual([
			['agent-1', 'completed', 'wrun00001', 1],
			['agent-2', 'working', 'wrun00001', 2],
			['wfq:wrun00001:3', 'queued', 'wrun00001', 3],
		])
		// A real child keeps its own transcript, under the run's grouping.
		expect(rows[0]?.transcript[0]).toMatchObject({ text: 'found nothing' })
		expect(rows[0]?.workflowGroupId).toBe('wfrun:wrun00001')
		expect(rows[0]?.phaseId).toBe('wfrun:wrun00001:p:1')
		expect(rows[2]?.transcript).toEqual([])
		expect(rows[2]?.phaseDetail).toBe('safe fixes only')
	})

	it('replaces the monitor rows of the run, and drops the children of a run that is gone', () => {
		const plain: SubagentActivity = {
			...children()[0],
			viewId: 'plain',
			workflowId: 'turn-1',
		} as never
		const shown = withWorkflowRuns([plain, ...children()], [run()])
		expect(shown.map((r) => r.viewId)).toEqual(['plain', 'agent-1', 'agent-2', 'wfq:wrun00001:3'])
		expect(withWorkflowRuns([plain, ...children()], []).map((r) => r.viewId)).toEqual(['plain'])
		expect(withWorkflowRuns([plain], [])).toEqual([plain])
	})
})

describe('the rail', () => {
	const shown = () => withWorkflowRuns(children(), [run()])

	it('never lists a run agent as an agent row', () => {
		expect(railAgents(shown(), NOW)).toEqual([])
	})

	it('gives the run one row that counts queued agents and sums their spend', () => {
		const [row] = railWorkflows(shown(), NOW, new Set(), [run()])
		expect(row).toMatchObject({
			name: 'audit',
			runId: 'wrun00001',
			done: 1,
			total: 3,
			tokens: 1500,
			status: 'running',
		})
		expect(row?.agents).toHaveLength(3)
	})

	it('has a row for a run before its first agent exists', () => {
		const empty = run({ agents: [] })
		const [row] = railWorkflows([], NOW, new Set(), [empty])
		expect(row).toMatchObject({
			name: 'audit',
			done: 0,
			total: 0,
			status: 'running',
		})
	})

	it('leaves 30 seconds after the run ended, and stays off once cleared', () => {
		const ended = run({ status: 'completed', endedAt: NOW - 10_000 })
		expect(railWorkflows(shown(), NOW, new Set(), [ended])).toHaveLength(1)
		expect(
			railWorkflows(shown(), NOW + AGENT_RAIL_FINISHED_LINGER_MS, new Set(), [ended]),
		).toHaveLength(0)
		expect(railNextEviction([], NOW, [ended])).toBe(AGENT_RAIL_FINISHED_LINGER_MS - 10_000)
		const [row] = railWorkflows(shown(), NOW, new Set(), [ended])
		expect(railWorkflows(shown(), NOW, new Set([row?.focusId ?? '']), [ended])).toHaveLength(0)
	})

	it('draws the row after nothing else', async () => {
		const rows = railWorkflows(shown(), NOW, new Set(), [run()])
		mounted = await renderToScreen(
			<Box flexDirection="column" paddingX={1}>
				<AgentTaskPanel
					agents={railAgents(shown(), NOW)}
					workflows={rows}
					terminalRows={40}
					terminalColumns={100}
					now={NOW}
				/>
			</Box>,
			{ cols: 100, rows: 8 },
		)
		const text = mounted
			.viewport()
			.filter((r) => r.trim())
			.join('\n')
		expect(text).toMatch(/◯ audit\s+▰+▱+\s+1\/3 · 20s · ↓ 1\.5k tokens/)
		expect(text).not.toContain('main')
		expect(text).not.toContain('Scan')
	})

	it('turns a finished run into the closing line the conversation keeps', () => {
		const ended = run({
			status: 'completed',
			endedAt: NOW,
			agents: run().agents.map((a) => ({ ...a, status: 'done' as const })),
		})
		const row = runRailWorkflow(ended, [])
		expect(row).toMatchObject({ status: 'completed', done: 3, total: 3 })
	})
})

describe('the phases of a run', () => {
	const shown = () => withWorkflowRuns(children(), [run()])

	it('lists the declared phases in the script order, the unstarted one empty', () => {
		const [flow] = agentWorkflows(shown(), [run()])
		expect(flow).toMatchObject({
			runId: 'wrun00001',
			description: 'Scan, then fix',
		})
		expect(flow?.phases.map((p) => [p.name, p.agents.length])).toEqual([
			['Scan', 2],
			['Fix', 1],
			['Report', 0],
		])
		const [scan, fix, report] = flow?.phases ?? []
		expect(scan && phaseOutcome(scan)).toBe('running')
		expect(report && phaseOutcome(report)).toBe('not-started')
		expect(report && phaseCount(report)).toBe('')
		expect(fix && phaseCount(fix)).toBe('0/1')
		// In a stopped run a phase where nothing finished says so, instead of 0/1.
		expect(
			fix &&
				phaseCount(
					{ agents: fix.agents.map((a) => ({ ...a, status: 'cancelled' as const })) },
					true,
				),
		).toBe('stopped')
		expect(scan && phaseCount(scan, true)).toBe(phaseCount(scan))
	})

	it('has a workflow for a run that has no agents yet, opening on its phases', () => {
		const [flow] = agentWorkflows([], [run({ agents: [] })])
		expect(flow?.phases.map((p) => p.name)).toEqual(['Scan', 'Fix', 'Report'])
		expect(flow && cockpitEntryFocus(flow)).toBe('phases')
	})

	it('does not fail a phase because the operator skipped one of its agents', () => {
		const skipped = run({
			agents: [
				agentView(1, 'done', { phaseIndex: 1, phaseTitle: 'Scan' }),
				agentView(2, 'skipped', {
					phaseIndex: 1,
					phaseTitle: 'Scan',
					finishedAt: NOW,
				}),
			],
		})
		const [flow] = agentWorkflows(withWorkflowRuns([], [skipped]), [skipped])
		expect(flow?.phases[0] && phaseOutcome(flow.phases[0])).toBe('done')
	})

	it('shows a phase whose agents were all skipped as skipped, never done', () => {
		const skipped = run({
			agents: [
				agentView(1, 'skipped', {
					phaseIndex: 1,
					phaseTitle: 'Scan',
					finishedAt: NOW,
				}),
				agentView(2, 'skipped', {
					phaseIndex: 1,
					phaseTitle: 'Scan',
					finishedAt: NOW,
				}),
			],
		})
		const [flow] = agentWorkflows(withWorkflowRuns([], [skipped]), [skipped])
		expect(flow?.phases[0] && phaseOutcome(flow.phases[0])).toBe('skipped')
	})

	it('groups agents with no phase under one Agents group, last', () => {
		const loose = run({
			phases: [],
			agents: [agentView(1, 'running'), agentView(2, 'queued')],
		})
		const [flow] = agentWorkflows(withWorkflowRuns([], [loose]), [loose])
		expect(flow?.phases).toHaveLength(1)
		expect(flow?.phases[0]?.agents).toHaveLength(2)
	})
})

describe('the detail view of a run', () => {
	async function detail(
		focus: 'phases' | 'agents',
		phaseIndex: number,
		selectedId: string,
		view: WorkflowRunView = run(),
	) {
		const agents = withWorkflowRuns(children(), [view])
		mounted = await renderToScreen(
			<Box flexDirection="column" paddingX={1}>
				<AgentCockpit
					agents={agents}
					runs={[view]}
					selectedPhaseId={`wfrun:${view.runId}:p:${phaseIndex}`}
					selectedId={selectedId}
					focus={focus}
					terminalRows={30}
					terminalColumns={100}
				/>
			</Box>,
			{ cols: 100, rows: 30 },
		)
		return mounted.viewport().join('\n')
	}

	it('level 1: the header, the phases with counts, and the unstarted one dim without a count', async () => {
		const text = await detail('phases', 1, 'agent-1')
		expect(text).toContain('audit')
		expect(text).toContain('Scan, then fix')
		expect(text).toContain('1/3 agents')
		expect(text).toMatch(/❯ 1\s+Scan\s+1\/2/)
		expect(text).toMatch(/2\s+Fix\s+0\/1/)
		expect(text).toMatch(/3\s+Report\s+│/)
		expect(text).toContain('x stop workflow')
	})

	it('shows the last log() lines under the header, the two before them dim, and drops older ones', async () => {
		const text = await detail(
			'phases',
			1,
			'agent-1',
			run({ logs: ['first', 'second', 'third', 'fourth'] }),
		)
		expect(text).toContain('second')
		expect(text).toContain('third')
		expect(text).toContain('fourth')
		expect(text).not.toContain('first')
		const rows = text.split('\n')
		expect(rows.findIndex((r) => r.includes('third'))).toBeLessThan(
			rows.findIndex((r) => r.includes('fourth')),
		)
		expect(rows.findIndex((r) => r.includes('Scan, then fix'))).toBeLessThan(
			rows.findIndex((r) => r.includes('second')),
		)
	})

	it('puts a phase detail under its title, before its agents, and leaves a space after the pointer', async () => {
		const text = await detail('phases', 2, 'wfq:wrun00001:3')
		const rows = text.split('\n')
		const detailRow = rows.findIndex((r) => r.includes('safe fixes only'))
		const agentRow = rows.findIndex((r) => r.includes('agent:3'))
		expect(detailRow).toBeGreaterThan(0)
		expect(detailRow).toBeLessThan(agentRow)
		const agents = await detail('agents', 2, 'wfq:wrun00001:3')
		expect(agents).toMatch(/│❯ [◌●✔✘] /u)
	})

	it('level 2: the agents of a phase, a queued one included, and x skips', async () => {
		const text = await detail('agents', 2, 'wfq:wrun00001:3')
		expect(text).toContain('Fix · 1 agent')
		expect(text).toMatch(/◌\s+agent:3/)
		expect(text).toContain('queued')
		expect(text).toContain('x skip')
	})

	it('level 2 of a phase nothing has started in says so', async () => {
		const text = await detail('agents', 3, '')
		expect(text).toContain('Report · 0 agents')
		expect(text).toContain('Not started yet')
		expect(text).not.toContain('x skip')
	})

	it('shows how a finished run ended, and offers no stop', async () => {
		const ended = run({
			status: 'stopped',
			endedAt: NOW,
			agents: run().agents.map((a) => ({ ...a, status: 'done' as const })),
		})
		const text = await detail('phases', 1, 'agent-1', ended)
		expect(text).toContain('· stopped')
		expect(text).not.toContain('x stop workflow')
	})
})

describe('the counters', () => {
	const mixedRun = (status: WorkflowRunView['status']) =>
		run({
			status,
			endedAt: status === 'running' ? undefined : NOW,
			agents: [
				agentView(1, 'done', { phaseIndex: 1, phaseTitle: 'Scan' }),
				agentView(2, 'skipped', {
					phaseIndex: 1,
					phaseTitle: 'Scan',
					finishedAt: NOW,
				}),
				agentView(3, 'failed', {
					phaseIndex: 1,
					phaseTitle: 'Scan',
					finishedAt: NOW,
				}),
				agentView(4, 'queued', { phaseIndex: 2, phaseTitle: 'Fix' }),
			],
		})

	it('counts only agents that completed: skipped and failed ones do not fill the bar', () => {
		const [row] = railWorkflows([], NOW, new Set(), [mixedRun('running')])
		expect(row).toMatchObject({ done: 1, total: 4, failed: 1 })
	})

	it('leaves a stopped run where it was, and says the outcome with the bullet only', () => {
		const stopped = mixedRun('stopped')
		const [row] = railWorkflows([], NOW, new Set(), [stopped])
		expect(row).toMatchObject({ done: 1, total: 4, status: 'stopped' })
		const [flow] = agentWorkflows(withWorkflowRuns([], [stopped]), [stopped])
		expect(flow?.phases[0] && phaseCount(flow.phases[0])).toBe('1/3')
	})

	it('puts the same count in the detail header, with the status suffix', async () => {
		const stopped = mixedRun('stopped')
		mounted = await renderToScreen(
			<Box flexDirection="column" paddingX={1}>
				<AgentCockpit
					agents={withWorkflowRuns([], [stopped])}
					runs={[stopped]}
					selectedPhaseId={`wfrun:${stopped.runId}:p:1`}
					selectedId=""
					focus="phases"
					terminalRows={30}
					terminalColumns={100}
				/>
			</Box>,
			{ cols: 100, rows: 30 },
		)
		const text = mounted.viewport().join('\n')
		expect(text).toContain('1/4 agents')
		expect(text).toContain('· stopped')
	})
})

describe('the transcript of a workflow agent', () => {
	async function transcript(agent: SubagentActivity) {
		mounted = await renderToScreen(
			<AgentTranscript
				agent={agent}
				tailOffset={0}
				terminalRows={30}
				terminalColumns={100}
				compact={false}
				escapeTo="agents"
				navigationHint="esc agents"
			/>,
			{ cols: 100, rows: 30 },
		)
		return mounted.viewport().join('\n')
	}

	it('is headed by the workflow and the phase, then the agent label, not "Subagent"', async () => {
		const [row] = projectRunAgents(run(), new Map(children().map((c) => [c.viewId, c])))
		const text = await transcript(row as SubagentActivity)
		expect(text).toContain('audit · Scan')
		expect(text).toContain('agent:1')
		expect(text).not.toContain('Subagent')
	})

	it('keeps the Subagent header for a child of the Agent tool', async () => {
		const [plain] = children()
		const text = await transcript({
			...(plain as SubagentActivity),
			workflow: 'Delegated work',
		})
		expect(text).toContain('Subagent')
	})
})
