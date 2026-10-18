/**
 * Workflows and subagents are two things. An agent the model gave a
 * `workflow` label lives only inside that workflow: never an agent row, never
 * its own launch or completion row. The workflow is one rail row, one group
 * line in the conversation, and a detail view of phases then agents.
 */

import { createRequire } from 'node:module'

import { Box } from 'ink'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import {
	AgentCockpit,
	AgentTaskPanel,
	agentPhases,
	agentWorkflows,
	cockpitEntryFocus,
	phaseCount,
	phaseOutcome,
	phaseTitle,
	railAgents,
	railShowsMain,
	railWorkflows,
} from '../AgentExplorer.js'
import { launchReceipt, settleLine } from '../agent-transcript-rows.js'
import { type Screen, renderToScreen } from './support/screen.js'

const NOW = 1_000_000

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

function agent(
	input: Partial<SubagentActivity> & Pick<SubagentActivity, 'viewId'>,
): SubagentActivity {
	return {
		agentId: 'general-purpose',
		description: input.viewId,
		prompt: 'p',
		batchId: 'batch-1',
		workflowId: 'turn-1',
		workflowGroupId: 'group-plain',
		phaseId: 'phase-work',
		workflow: 'Delegated work',
		phase: 'Work',
		phaseSequence: 0,
		status: 'working',
		startedAt: NOW - 60_000,
		transcript: [],
		...input,
	}
}

function labelled(
	viewId: string,
	phase: string,
	order: number,
	extra: Partial<SubagentActivity> = {},
): SubagentActivity {
	return agent({
		viewId,
		workflow: 'Surum denetimi',
		workflowGroupId: 'group-audit',
		phase,
		phaseId: `phase-${phase}`,
		phaseOrder: order,
		...extra,
	})
}

const done = { status: 'completed' as const, completedAt: NOW - 10_000 }

/** Two plain subagents, a workflow with `Tarama` (3) and `Duzeltme` (2). */
function mixed(): SubagentActivity[] {
	return [
		agent({ viewId: 's1' }),
		agent({ viewId: 's2' }),
		labelled('t1', 'Tarama', 1, done),
		labelled('t2', 'Tarama', 1),
		labelled('t3', 'Tarama', 1),
		labelled('f1', 'Duzeltme', 2, { status: 'queued' }),
		labelled('f2', 'Duzeltme', 2, { status: 'queued' }),
	]
}

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

describe('the rail', () => {
	it('never lists an agent that carries a workflow label', () => {
		const rows = railAgents(mixed(), NOW)
		expect(rows.map((row) => row.viewId)).toEqual(['s1', 's2'])
	})

	it('lists the workflow once, whatever its agents are doing', () => {
		const flows = railWorkflows(mixed(), NOW)
		expect(flows).toHaveLength(1)
		expect(flows[0]).toMatchObject({
			name: 'Surum denetimi',
			done: 1,
			total: 5,
		})
	})

	it('draws main only beside an agent row, a viewed agent, or in the one-row form', () => {
		expect(railShowsMain(0)).toBe(false)
		expect(railShowsMain(2)).toBe(true)
		expect(railShowsMain(0, 'a1')).toBe(true)
		expect(railShowsMain(0, null)).toBe(false)
		expect(railShowsMain(0, undefined, true)).toBe(true)
	})

	async function rail(agents: readonly SubagentActivity[], selectedIndex?: number) {
		mounted = await renderToScreen(
			<Box flexDirection="column" paddingX={1}>
				<AgentTaskPanel
					agents={railAgents(agents, NOW)}
					workflows={railWorkflows(agents, NOW)}
					terminalRows={40}
					terminalColumns={100}
					now={NOW}
					{...(selectedIndex !== undefined ? { selectedIndex } : {})}
				/>
			</Box>,
			{ cols: 100, rows: 14 },
		)
		return mounted.viewport().filter((row) => row.trim().length > 0)
	}

	it('shows main, the plain agents, then the workflow row with no phase text', async () => {
		const rows = await rail(mixed())
		expect(rows[0]).toContain('main')
		expect(rows.some((row) => row.includes('s1'))).toBe(true)
		expect(rows.some((row) => row.includes('t1'))).toBe(false)
		const flowRow = rows.findIndex((row) => row.includes('Surum denetimi'))
		expect(flowRow).toBeGreaterThan(rows.findIndex((row) => row.includes('s2')))
		const text = rows.join('\n')
		expect(text).not.toContain('Tarama')
		expect(text).not.toContain('Duzeltme')
		expect(text).toContain('1/5')
	})

	it('has no main row when only a workflow is running, and index 0 is the workflow', async () => {
		const rows = await rail(
			mixed().filter((a) => a.workflow !== 'Delegated work'),
			0,
		)
		expect(rows.some((row) => row.includes('main'))).toBe(false)
		expect(rows[0]).toContain('❯')
		expect(rows[0]).toContain('Surum denetimi')
	})
})

describe('phases of a workflow', () => {
	it('groups agents by the model label, in phase_order, titled verbatim', () => {
		const [workflow] = agentWorkflows(mixed().filter((a) => a.workflow !== 'Delegated work'))
		expect(workflow?.phases.map((phase) => phaseTitle(phase))).toEqual(['Tarama', 'Duzeltme'])
		expect(workflow?.phases.map((phase) => phase.agents.length)).toEqual([3, 2])
	})

	it('orders by phase_order before first seen', () => {
		const phases = agentPhases([labelled('b', 'Ikinci', 2), labelled('a', 'Birinci', 1)])
		expect(phases.map((phase) => phase.name)).toEqual(['Birinci', 'Ikinci'])
	})

	it('titles an unlabelled group Agents', () => {
		const [phase] = agentPhases([labelled('a', 'Work', 0)])
		expect(phase && phaseTitle(phase)).toBe('Agents')
	})

	it('derives running, done and failed from the agents alone', () => {
		const flow = agentWorkflows(mixed().filter((a) => a.workflow !== 'Delegated work'))[0]
		const [scan, fix] = flow?.phases ?? []
		expect(scan && phaseOutcome(scan)).toBe('running')
		expect(scan && phaseCount(scan)).toBe('1/3')
		expect(fix && phaseCount(fix)).toBe('0/2')
		expect(phaseOutcome({ agents: [agent({ viewId: 'a', ...done })] })).toBe('done')
		expect(
			phaseOutcome({
				agents: [
					agent({ viewId: 'a', ...done }),
					agent({ viewId: 'b', status: 'failed', completedAt: NOW }),
				],
			}),
		).toBe('failed')
	})

	it('opens a labelled workflow on its phases, plain work on its agents', () => {
		const [flow] = agentWorkflows(mixed().filter((a) => a.workflow !== 'Delegated work'))
		expect(flow && cockpitEntryFocus(flow)).toBe('phases')
		const [plain] = agentWorkflows([agent({ viewId: 'a' })])
		expect(plain && cockpitEntryFocus(plain)).toBe('agents')
		const [single] = agentWorkflows([labelled('a', 'Work', 0)])
		expect(single && cockpitEntryFocus(single)).toBe('phases')
	})
})

describe('the detail view', () => {
	const flowAgents = mixed().filter((a) => a.workflow !== 'Delegated work')
	async function detail(focus: 'phases' | 'agents', phase: string, id: string) {
		mounted = await renderToScreen(
			<Box flexDirection="column" paddingX={1}>
				<AgentCockpit
					agents={flowAgents}
					selectedPhaseId={`phase-${phase}`}
					selectedId={id}
					focus={focus}
					terminalRows={40}
					terminalColumns={100}
				/>
			</Box>,
			{ cols: 100, rows: 40 },
		)
		return mounted.viewport().join('\n')
	}

	it('level 1 lists phases with index, title and done/total, and the header totals', async () => {
		const text = await detail('phases', 'Tarama', 't1')
		expect(text).toContain('Surum denetimi')
		expect(text).toContain('1/5 agents')
		expect(text).toContain('Phases')
		expect(text).toMatch(/❯ 1\s+Tarama\s+1\/3/)
		expect(text).toMatch(/2\s+Duzeltme\s+0\/2/)
		expect(text).toContain('esc back')
		expect(text).toContain('x stop workflow')
		expect(text).not.toContain('Not started yet')
	})

	it('level 2 titles the phase with its agent count and marks each agent', async () => {
		const text = await detail('agents', 'Tarama', 't1')
		expect(text).toContain('Tarama · 3 agents')
		expect(text).toMatch(/✔\s+t1/)
		expect(text).toMatch(/●\s+t2/)
		const queued = await detail('agents', 'Duzeltme', 'f1')
		expect(queued).toContain('Duzeltme · 2 agents')
		expect(queued).toMatch(/◌\s+f1/)
	})
})

describe('the conversation', () => {
	it('writes one group line for labelled agents instead of per-agent rows', () => {
		const receipt = launchReceipt(mixed().filter((a) => a.workflow !== 'Delegated work'))
		expect(receipt.content).toBe('Workflow Surum denetimi\n⎿ Running in background · ↓ to manage')
	})

	it('keeps a launch row for unlabelled agents', () => {
		const receipt = launchReceipt([agent({ viewId: 's1' }), agent({ viewId: 's2' })])
		expect(receipt.content).toContain('Launched 2 agents')
	})

	it('leaves phases out of the turn summary', () => {
		const line = settleLine(13_000, [
			labelled('a', 'Tarama', 1, done),
			labelled('b', 'Duzeltme', 2, done),
		])
		expect(line).toBe('Worked for 13s · 2 agents')
		expect(line).not.toContain('phase')
	})
})
