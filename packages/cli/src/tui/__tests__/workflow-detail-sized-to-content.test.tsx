/**
 * The workflow detail is as tall as what it lists: its chrome, its log lines and the longer of the
 * phase list and the agent list, never under the floor and never over the free rows.
 */

import { Box } from 'ink'
import { afterEach, describe, expect, it } from 'vitest'

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import {
	AgentCockpit,
	type AgentWorkflow,
	DETAIL_FLOOR_ROWS,
	agentPhases,
	agentWorkflows,
	cockpitDetailHeight,
	sizeWorkflowDetail,
	workflowDetailContentRows,
	workflowDetailHeight,
} from '../AgentExplorer.js'
import { type Screen, renderToScreen } from './support/screen.js'

function member(viewId: string, phase: string, order: number): SubagentActivity {
	return {
		viewId,
		agentId: 'general-purpose',
		description: `label ${viewId}`,
		prompt: 'p',
		batchId: 'b',
		workflowId: 'turn',
		workflowGroupId: JSON.stringify(['turn', 'workflow', 'Release audit']),
		phaseId: JSON.stringify(['turn', 'Release audit', phase]),
		workflow: 'Release audit',
		phase,
		phaseOrder: order,
		phaseSequence: order,
		status: 'completed',
		startedAt: 1_000,
		completedAt: 24_000,
		tokens: 1,
		outputTokens: 1,
		sentTokens: 1,
		cachedTokens: 0,
		model: 'gpt-x',
		transcript: [],
	} as SubagentActivity
}

const phaseOf = (agent: SubagentActivity) => agent.phaseId
const some = (count: number) =>
	Array.from({ length: count }, (_, index) => member(`a${index}`, 'Review', 0))

const ROWS = 47
const COLS = 160
const cap = workflowDetailHeight(ROWS, true)

function height(agents: readonly SubagentActivity[], focus: 'phases' | 'agents' = 'agents') {
	return cockpitDetailHeight(
		agents,
		[],
		phaseOf(agents[0] as SubagentActivity),
		focus,
		ROWS,
		COLS,
		cap,
	)
}

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

describe('the height of the workflow detail', () => {
	it('is 10 rows for one phase of two agents in the full screen view at 47 rows', () => {
		expect(cap).toBe(23)
		expect(height(some(2))).toBe(10)
		expect(height(some(2), 'phases')).toBe(10)
	})

	it('is never over the cap and never under the floor', () => {
		for (const count of [1, 2, 5, 12, 30]) {
			const value = height(some(count))
			expect(value).toBeLessThanOrEqual(cap)
			expect(value).toBeGreaterThanOrEqual(DETAIL_FLOOR_ROWS)
		}
		expect(height(some(1))).toBe(DETAIL_FLOOR_ROWS + 2)
	})

	it('is the cap for 30 agents', () => {
		expect(height(some(30))).toBe(cap)
	})

	it('grows with the agents, a row each', () => {
		expect(height(some(8))).toBe(height(some(7)) + 1)
	})

	it('adds a row for each log line, up to the cap and up to three lines', () => {
		const agents = some(2)
		const phases = agentPhases(agents)
		const base = agentWorkflows(agents, [])[0] as AgentWorkflow
		const rowsWith = (logs: readonly string[]) =>
			sizeWorkflowDetail(
				cap,
				workflowDetailContentRows({ ...base, logs }, phases, 0, 2, ROWS, COLS),
			)
		expect(rowsWith([])).toBe(10)
		expect(rowsWith(['one'])).toBe(11)
		expect(rowsWith(['one', 'two'])).toBe(12)
		expect(rowsWith(['one', 'two', 'three', 'four'])).toBe(13)
		const tight = workflowDetailHeight(14, false)
		expect(
			sizeWorkflowDetail(
				tight,
				workflowDetailContentRows({ ...base, logs: ['a', 'b', 'c'] }, phases, 0, 2, 40, COLS),
			),
		).toBeLessThanOrEqual(tight)
	})

	it('is the cap for the list of workflows', () => {
		const agents = some(2)
		expect(
			cockpitDetailHeight(
				agents,
				[],
				phaseOf(agents[0] as SubagentActivity),
				'workflows',
				ROWS,
				COLS,
				cap,
			),
		).toBe(cap)
	})
})

describe('the detail as drawn', () => {
	it('has no blank row between the last agent and the key line', async () => {
		const agents = some(2)
		const rows = 30
		const columns = 100
		const detailCap = workflowDetailHeight(rows, false)
		const value = cockpitDetailHeight(
			agents,
			[],
			phaseOf(agents[0] as SubagentActivity),
			'agents',
			rows,
			columns,
			detailCap,
		)
		mounted = await renderToScreen(
			<Box flexDirection="column">
				<Box height={value} flexShrink={0} flexDirection="column" overflowY="hidden">
					<AgentCockpit
						agents={agents}
						selectedPhaseId={phaseOf(agents[0] as SubagentActivity)}
						selectedId="a0"
						focus="agents"
						terminalRows={rows}
						terminalColumns={columns}
						height={value}
					/>
				</Box>
			</Box>,
			{ cols: columns, rows },
		)
		const screen = mounted.viewport()
		const last = screen.map((row) => row.includes('label a1')).lastIndexOf(true)
		const key = screen.findIndex((row) => row.includes('space close'))
		expect(last).toBeGreaterThan(0)
		// The agent row, the bottom border of the box, then the key line.
		expect(key - last).toBe(2)
		expect(screen[key + 1]?.trim() ?? '').toBe('')
		expect(value).toBeLessThan(detailCap)
	})

	it.each([
		[50, 24],
		[80, 24],
		[100, 30],
	])('ends on its key line at %i columns and %i rows', async (columns, rows) => {
		const agents = some(2)
		const detailCap = workflowDetailHeight(rows, false)
		const value = cockpitDetailHeight(
			agents,
			[],
			phaseOf(agents[0] as SubagentActivity),
			'agents',
			rows,
			columns,
			detailCap,
		)
		mounted = await renderToScreen(
			<Box flexDirection="column">
				<Box height={value} flexShrink={0} flexDirection="column" overflowY="hidden">
					<AgentCockpit
						agents={agents}
						selectedPhaseId={phaseOf(agents[0] as SubagentActivity)}
						selectedId="a0"
						focus="agents"
						terminalRows={rows}
						terminalColumns={columns}
						height={value}
					/>
				</Box>
			</Box>,
			{ cols: columns, rows },
		)
		const screen = mounted.viewport()
		const key = screen.findIndex((row) => row.includes('space close'))
		expect(key).toBeGreaterThan(0)
		// The key line is the last row of the detail: nothing is left blank under it, and both agents are drawn.
		expect(key).toBe(value - 1)
		expect(screen.some((row) => row.includes('label a0'))).toBe(true)
		expect(screen.some((row) => row.includes('label a1'))).toBe(true)
	})
})
