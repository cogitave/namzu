/**
 * Teammates on the agents rail: a row each with name, state and task; idle rows leave after the rail
 * has been idle for a while; more than three idle are one counted row. The keys are the rail's own
 * (arrows, enter, x), driven through the real terminal in the pty check.
 */

import { Box } from 'ink'
import { afterEach, describe, expect, it } from 'vitest'

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import type { TeamMemberView, TeamTaskView } from '../../integrations/teams/view.js'
import {
	AgentTaskPanel,
	railActionFor,
	railAgents,
	railNextEviction,
	teamRailOf,
} from '../AgentExplorer.js'
import { TEAM_IDLE_FADE_MS } from '../team-view.js'
import { type Screen, renderToScreen } from './support/screen.js'

const NOW = 1_000_000

function agent(viewId: string, patch: Partial<SubagentActivity> = {}): SubagentActivity {
	return {
		viewId,
		agentId: 'teammate-type',
		description: `${viewId} works`,
		prompt: 'p',
		batchId: 'batch-1',
		workflowId: 'turn-1',
		workflowGroupId: 'group-1',
		phaseId: 'phase-1',
		workflow: 'Delegated work',
		phase: 'Work',
		phaseSequence: 0,
		// A teammate between turns has a completed task: that is idle, not the end of the agent.
		status: 'completed',
		background: true,
		startedAt: NOW - 60_000,
		completedAt: NOW - 20_000,
		transcript: [],
		...patch,
	}
}

function member(name: string, state: TeamMemberView['state'], since = 0): TeamMemberView {
	return { name, viewId: `v-${name}`, state, since }
}

const rowsFor = (members: readonly TeamMemberView[]) => members.map((m) => agent(m.viewId))

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

async function show(
	members: readonly TeamMemberView[],
	tasks: readonly TeamTaskView[],
	cols: number,
	options: { selectedIndex?: number } = {},
) {
	const agents = rowsFor(members)
	const team = teamRailOf({ members, tasks }, agents, NOW)
	const listed = railAgents(agents, NOW, new Set(), null, team)
	mounted = await renderToScreen(
		<Box flexDirection="column" paddingLeft={0} paddingRight={1}>
			<AgentTaskPanel
				agents={listed}
				{...(team ? { team } : {})}
				terminalRows={40}
				terminalColumns={cols}
				now={NOW}
				{...(options.selectedIndex !== undefined ? { selectedIndex: options.selectedIndex } : {})}
			/>
		</Box>,
		{ cols, rows: 16 },
	)
	return mounted.viewport().filter((row) => row.trim().length > 0)
}

describe('which rows the rail lists for a team', () => {
	it('keeps an idle teammate whose turn has ended, which a finished background agent would not', () => {
		const members = [member('one', 'idle', NOW - 5_000)]
		const team = teamRailOf({ members, tasks: [] }, rowsFor(members), NOW)
		expect(railAgents(rowsFor(members), NOW, new Set(), null, team).map((a) => a.viewId)).toEqual([
			'v-one',
		])
		expect(railAgents(rowsFor(members), NOW).map((a) => a.viewId)).toEqual([])
	})

	it('drops idle teammates after the whole rail has been idle for 30 seconds', () => {
		const members = [member('one', 'idle', NOW - TEAM_IDLE_FADE_MS)]
		const team = teamRailOf({ members, tasks: [] }, rowsFor(members), NOW)
		expect(railAgents(rowsFor(members), NOW, new Set(), null, team)).toEqual([])
	})

	it('keeps the teammate on screen even when it would have faded', () => {
		const members = [member('one', 'idle', NOW - 10 * TEAM_IDLE_FADE_MS)]
		const team = teamRailOf({ members, tasks: [] }, rowsFor(members), NOW)
		expect(railAgents(rowsFor(members), NOW, new Set(), 'v-one', team)).toHaveLength(1)
	})

	it('schedules the fade, and offers x as stop for a teammate that is not stopped', () => {
		const members = [member('one', 'idle', NOW - 5_000)]
		const team = teamRailOf({ members, tasks: [] }, rowsFor(members), NOW)
		expect(railNextEviction(rowsFor(members), NOW, [], team)).toBe(TEAM_IDLE_FADE_MS - 5_000)
		const row = agent('v-one')
		expect(railActionFor(row)).toBe('clear')
		expect(railActionFor(row, member('one', 'idle', NOW))).toBe('stop')
		expect(railActionFor(row, member('one', 'stopped', NOW))).toBe('clear')
	})
})

describe('the team rows on the screen', () => {
	const tasks: TeamTaskView[] = [
		{ id: '1', subject: 'write the parser', status: 'in_progress', owner: 'one', blockedBy: [] },
	]

	it('draws name, task and state per teammate, with the folded row for the rest', async () => {
		const rows = await show(
			[member('one', 'working'), member('two', 'waiting'), member('three', 'idle', NOW - 9_000)],
			tasks,
			100,
		)
		const text = rows.join('\n')
		expect(text).toContain('one')
		expect(text).toContain('write the parser')
		expect(text).toContain('working')
		expect(text).toContain('waiting for you')
		expect(text).toContain('idle · 9s')
	})

	it('counts more than three idle teammates in one row', async () => {
		const rows = await show(
			['a', 'b', 'c', 'd'].map((n) => member(n, 'idle', NOW - 2_000)),
			[],
			100,
		)
		expect(rows.join('\n')).toContain('4 idle teammates')
		expect(rows.join('\n')).not.toContain('idle · 2s')
	})

	it('fits a narrow terminal and long names without a row wider than the screen', async () => {
		for (const cols of [120, 80, 50]) {
			const rows = await show(
				[
					member('a-teammate-with-a-very-long-name-indeed', 'working'),
					member('two', 'idle', NOW - 3_000),
				],
				[
					{
						id: '1',
						subject: 'a task with a subject long enough that it cannot fit on any one row at all',
						status: 'in_progress',
						owner: 'a-teammate-with-a-very-long-name-indeed',
						blockedBy: [],
					},
				],
				cols,
			)
			for (const row of rows) expect(row.length).toBeLessThanOrEqual(cols)
			expect(rows.join('\n')).toContain('working')
		}
	})

	it('marks the selected teammate row', async () => {
		const rows = await show([member('one', 'working')], tasks, 100, { selectedIndex: 1 })
		expect(rows.some((row) => row.includes('❯') && row.includes('one'))).toBe(true)
	})
})
