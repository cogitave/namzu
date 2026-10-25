/**
 * What a finished workflow with a failed agent says about its agents, surface
 * by surface: the detail header and the rail carry done over total, the agent
 * list of a phase names its failures in the error colour, and the closing line
 * in the conversation carries the total only.
 */
import { createRequire } from 'node:module'

import { Box } from 'ink'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import { initialRunView } from '../../integrations/workflows/view.js'
import type { WorkflowAgentView, WorkflowRunView } from '../../integrations/workflows/view.js'
import { AgentCockpit, railWorkflows, runRailWorkflow } from '../AgentExplorer.js'
import { workflowNotice } from '../agent-transcript-rows.js'
import { withWorkflowRuns } from '../workflow-runs.js'
import { type Screen, renderToScreen } from './support/screen.js'

const NOW = Date.now()

const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as { level: number }
const originalColorLevel = chalk.level
beforeAll(() => {
	chalk.level = 3
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
		tokens: 10,
		toolCalls: 0,
		status,
		startedAt: NOW - 15_000,
		finishedAt: NOW - 5_000,
		phaseIndex: 1,
		phaseTitle: 'Scan',
		viewId: `agent-${index}`,
		...extra,
	}
}

/** Two agents completed and one failed: `done` is 2 of 3. */
function failedRun(): WorkflowRunView {
	return {
		...initialRunView({
			runId: 'wfail0001',
			name: 'audit',
			description: 'Scan',
			phases: [{ title: 'Scan' }],
			at: NOW - 20_000,
		}),
		status: 'failed',
		endedAt: NOW - 5_000,
		agents: [agentView(1, 'done'), agentView(2, 'failed'), agentView(3, 'done')],
	}
}

async function detail(cols: number, focus: 'phases' | 'agents') {
	const view = failedRun()
	mounted = await renderToScreen(
		<Box flexDirection="column" paddingX={1}>
			<AgentCockpit
				agents={withWorkflowRuns([], [view])}
				runs={[view]}
				selectedPhaseId={`wfrun:${view.runId}:p:1`}
				selectedId="agent-1"
				focus={focus}
				terminalRows={30}
				terminalColumns={cols}
			/>
		</Box>,
		{ cols, rows: 30 },
	)
	return mounted
}

describe.each([100, 60])('the detail of a run with a failed agent at %i columns', (cols) => {
	it('puts done over total in the header and no failure count beside it', async () => {
		const screen = await detail(cols, 'phases')
		const header = screen.viewport().find((row) => row.includes('2/3 agents'))
		expect(header).toBeDefined()
		expect(header).not.toContain('failed ·')
		expect(header).not.toMatch(/\d+ failed/)
	})

	it('colours a phase row failed count after its done over total', async () => {
		const screen = await detail(cols, 'phases')
		const rows = screen.viewport()
		const at = rows.findIndex((row) => /2\/3 · 1 failed/u.test(row))
		expect(at).toBeGreaterThanOrEqual(0)
		const row = rows[at] as string
		const col = row.indexOf('1 failed')
		expect(screen.cell(at, col).fg).not.toBe('default')
		expect(screen.cell(at, row.indexOf('2/3')).fg).not.toBe(screen.cell(at, col).fg)
	})

	it('names the failures after the phase agent count, in the error colour', async () => {
		const screen = await detail(cols, 'agents')
		const rows = screen.viewport()
		const at = rows.findIndex((row) => row.includes('Scan · 3 agents · 2 done · 1 failed'))
		expect(at).toBeGreaterThanOrEqual(0)
		const row = rows[at] as string
		const col = row.indexOf('1 failed')
		expect(screen.cell(at, col).fg).not.toBe('default')
		expect(screen.cell(at, row.indexOf('3 agents')).fg).not.toBe(screen.cell(at, col).fg)
	})
})

describe('the rail and the closing line of a run with a failed agent', () => {
	it('counts done over total for the rail, and the closing line says the total', () => {
		const [row] = railWorkflows([], NOW, new Set(), [failedRun()])
		expect(row).toMatchObject({ done: 2, total: 3, failed: 1 })
		const notice = workflowNotice(runRailWorkflow(failedRun(), []), NOW)
		expect(notice.content).toMatch(/^Workflow audit failed · .* · 3 agents · 30 tokens$/u)
	})
})

describe('a labelled group that is not a run, with one failed agent', () => {
	function group(): SubagentActivity[] {
		return (['completed', 'failed', 'completed'] as const).map((status, i) => ({
			agentId: 'general-purpose',
			description: `a${i}`,
			prompt: 'p',
			batchId: 'batch-1',
			workflowId: 'turn-1',
			workflowGroupId: 'group-audit',
			phaseId: 'phase-1',
			workflow: 'Release audit',
			phase: 'Work',
			phaseSequence: 0,
			status,
			startedAt: NOW - 15_000,
			completedAt: NOW - 5_000,
			viewId: `g${i}`,
			transcript: [],
		}))
	}

	it('counts a failed agent as not done on the rail', () => {
		const [row] = railWorkflows(group(), NOW)
		expect(row).toMatchObject({ done: 2, total: 3, failed: 1, status: 'failed' })
	})

	it('reads 2/3 in the detail header', async () => {
		mounted = await renderToScreen(
			<Box flexDirection="column" paddingX={1}>
				<AgentCockpit
					agents={group()}
					runs={[]}
					selectedPhaseId="phase-1"
					selectedId="g0"
					focus="phases"
					terminalRows={30}
					terminalColumns={100}
				/>
			</Box>,
			{ cols: 100, rows: 30 },
		)
		expect(mounted.viewport().some((row) => row.includes('2/3 agents'))).toBe(true)
	})
})
