/**
 * Workflow rows on the agents rail: one row per `workflow` label, drawn after
 * the agent rows as `◯ name  ▰▱ bar  3/7 · 2m14s · ↓ 48.2k tokens`. Which
 * workflows are listed, how a row narrows, the bullet's colours, the 30 s
 * lifetime and the key line are checked here; Enter, `x` and Esc go through
 * the real terminal in the pty lab (see docs/cli/terminal-design.md).
 */

import { createRequire } from 'node:module'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import { initialRunView } from '../../integrations/workflows/view.js'
import {
	AGENT_RAIL_FINISHED_LINGER_MS,
	AgentTaskPanel,
	type RailWorkflow,
	layoutWorkflowRow,
	railHint,
	railProgressBar,
	railWorkflowActionFor,
	railWorkflows,
	workflowRowVariants,
} from '../AgentExplorer.js'
import { workflowNotice } from '../agent-transcript-rows.js'
import { type Screen, renderToScreen } from './support/screen.js'

const NOW = 1_000_000
const ESC = String.fromCharCode(27)

const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as { level: number }
const originalColorLevel = chalk.level
beforeAll(() => {
	chalk.level = 3
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
		workflowGroupId: 'group-audit',
		phaseId: 'phase-1',
		workflow: 'Release audit',
		phase: 'Work',
		phaseSequence: 0,
		status: 'working',
		startedAt: NOW - 134_000,
		transcript: [],
		...input,
	}
}

/** Seven agents, three settled, 48.2k tokens between them. */
function sevenAgents(): SubagentActivity[] {
	return Array.from({ length: 7 }, (_, i) =>
		agent({
			viewId: `w${i}`,
			...(i < 3 ? { status: 'completed' as const, completedAt: NOW - 20_000 } : {}),
			...(i === 0 ? { tokens: 48_200 } : {}),
		}),
	)
}

function workflowOf(agents: readonly SubagentActivity[], now = NOW): RailWorkflow {
	const [row] = railWorkflows(agents, now)
	if (!row) throw new Error('no workflow row')
	return row
}

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

async function show(
	workflows: readonly RailWorkflow[],
	props: { selectedIndex?: number; cols?: number; agents?: readonly SubagentActivity[] } = {},
) {
	const cols = props.cols ?? 100
	mounted = await renderToScreen(
		<AgentTaskPanel
			agents={props.agents ?? []}
			workflows={workflows}
			terminalRows={40}
			terminalColumns={cols}
			now={NOW}
			{...(props.selectedIndex !== undefined ? { selectedIndex: props.selectedIndex } : {})}
		/>,
		{ cols, rows: 14 },
	)
	return mounted.viewport().filter((row) => row.trim().length > 0)
}

describe('a workflow run that ended with no agent', () => {
	const base = initialRunView({
		runId: 'wrun00009',
		name: 'typo-fix',
		description: 'd',
		phases: [],
		at: NOW - 100,
	})
	it('leaves the rail at once instead of lingering as 0/0, while a running one keeps its row', () => {
		const ended = { ...base, status: 'failed' as const, endedAt: NOW, error: 'boom' }
		expect(railWorkflows([], NOW, new Set(), [ended])).toEqual([])
		expect(railWorkflows([], NOW, new Set(), [base]).map((row) => row.runId)).toEqual(['wrun00009'])
	})
})

describe('which workflows the rail lists', () => {
	it('lists a group with an explicit workflow label, counting settled agents', () => {
		const row = workflowOf(sevenAgents())
		expect(row).toMatchObject({
			name: 'Release audit',
			done: 3,
			total: 7,
			tokens: 48_200,
			status: 'running',
		})
		expect(row.endedAt).toBeUndefined()
	})

	it('leaves out unlabelled batches, saved children and cleared workflows', () => {
		const unlabelled = [agent({ viewId: 'u', workflow: 'Delegated work' })]
		expect(railWorkflows(unlabelled, NOW)).toEqual([])
		expect(railWorkflows([agent({ viewId: 's', replayed: true })], NOW)).toEqual([])
		const row = workflowOf(sevenAgents())
		expect(railWorkflows(sevenAgents(), NOW, new Set([row.focusId]))).toEqual([])
	})

	it('orders workflows oldest first', () => {
		const rows = railWorkflows(
			[
				agent({ viewId: 'b', workflow: 'Second', workflowGroupId: 'g2', startedAt: 9 }),
				agent({ viewId: 'a', workflow: 'First', workflowGroupId: 'g1', startedAt: 3 }),
			],
			NOW,
		)
		expect(rows.map((row) => row.name)).toEqual(['First', 'Second'])
	})

	it('keeps a finished workflow for 30 seconds from its last agent, then drops it', () => {
		const done = [
			agent({ viewId: 'a', status: 'completed', completedAt: NOW - 10_000 }),
			agent({ viewId: 'b', status: 'completed', completedAt: NOW - 1_000 }),
		]
		expect(workflowOf(done).status).toBe('completed')
		expect(workflowOf(done).endedAt).toBe(NOW - 1_000)
		expect(railWorkflows(done, NOW + AGENT_RAIL_FINISHED_LINGER_MS - 1_001)).toHaveLength(1)
		expect(railWorkflows(done, NOW + AGENT_RAIL_FINISHED_LINGER_MS - 1_000)).toEqual([])
	})

	it('reads the outcome: failed beats stopped beats completed', () => {
		const make = (...statuses: SubagentActivity['status'][]) =>
			statuses.map((status, i) => agent({ viewId: `m${i}`, status, completedAt: NOW - 1_000 }))
		expect(workflowOf(make('completed', 'completed')).status).toBe('completed')
		expect(workflowOf(make('completed', 'cancelled')).status).toBe('stopped')
		expect(workflowOf(make('cancelled', 'failed')).status).toBe('failed')
		expect(workflowOf(make('failed', 'working')).status).toBe('running')
	})

	it('says stop while anything runs and clear once it has finished', () => {
		expect(railWorkflowActionFor(workflowOf(sevenAgents()))).toBe('stop')
		const done = [agent({ viewId: 'a', status: 'completed', completedAt: NOW })]
		expect(railWorkflowActionFor(workflowOf(done))).toBe('clear')
	})
})

describe('the progress bar', () => {
	it('fills the share of settled agents, rounded down', () => {
		expect(railProgressBar(3, 7, 20)).toEqual(['▰'.repeat(8), '▱'.repeat(12)])
		expect(railProgressBar(0, 7, 8)).toEqual(['', '▱'.repeat(8)])
		expect(railProgressBar(7, 7, 12)).toEqual(['▰'.repeat(12), ''])
		expect(railProgressBar(0, 0, 8)).toEqual(['', '▱'.repeat(8)])
	})
})

describe('narrowing a row', () => {
	const row = workflowOf(sevenAgents())

	it('lists the variants from the full block down to the bar alone', () => {
		expect(workflowRowVariants(row, NOW)).toEqual([
			{ barWidth: 20, text: '3/7 · 2m14s · ↓ 48.2k tokens' },
			{ barWidth: 20, text: '2m14s · ↓ 48.2k tokens' },
			{ barWidth: 20, text: '2m14s · ↓ 48.2k' },
			{ barWidth: 20, text: '↓ 48.2k' },
			{ barWidth: 12, text: '↓ 48.2k' },
			{ barWidth: 8, text: '↓ 48.2k' },
			{ barWidth: 8, text: '' },
		])
	})

	it('shows no token segment before any agent reported spend', () => {
		const quiet = workflowOf([agent({ viewId: 'q' })])
		expect(workflowRowVariants(quiet, NOW)[0]?.text).toBe('0/1 · 2m14s')
	})

	it.each([
		[100, 20, '3/7 · 2m14s · ↓ 48.2k tokens'],
		[66, 20, '3/7 · 2m14s · ↓ 48.2k tokens'],
		[65, 20, '2m14s · ↓ 48.2k tokens'],
		[60, 20, '2m14s · ↓ 48.2k tokens'],
		[59, 20, '2m14s · ↓ 48.2k'],
		[53, 20, '2m14s · ↓ 48.2k'],
		[52, 20, '↓ 48.2k'],
		[45, 20, '↓ 48.2k'],
		[44, 12, '↓ 48.2k'],
		[37, 12, '↓ 48.2k'],
		[36, 8, '↓ 48.2k'],
		[33, 8, '↓ 48.2k'],
		[32, 8, ''],
	])('at %i columns uses a %i cell bar and %j', (columns, barWidth, text) => {
		const { variant } = layoutWorkflowRow(row, NOW, columns, 'Release audit'.length)
		expect(variant).toEqual({ barWidth, text })
	})

	it('squeezes the name only after the numbers have given way', () => {
		const wide = layoutWorkflowRow(row, NOW, 100, 13)
		expect(wide.nameWidth).toBe(13)
		const tight = layoutWorkflowRow(row, NOW, 66, 28)
		expect(tight.nameWidth).toBeGreaterThanOrEqual(8)
		expect(tight.nameWidth).toBeLessThan(28)
	})

	it('never draws a row wider than the terminal', async () => {
		for (const cols of [100, 70, 58, 50, 40, 34, 24]) {
			const rows = await show([row], { cols })
			for (const line of rows) expect(line.length).toBeLessThanOrEqual(cols)
			await mounted?.unmount()
			mounted = undefined
		}
	})
})

describe('the rows on screen', () => {
	it('draws the row under the agent rows, sharing their name column', async () => {
		const agents = [agent({ viewId: 'solo', workflow: 'Delegated work', workflowGroupId: 'g0' })]
		const rows = await show([workflowOf(sevenAgents())], { agents })
		expect(rows[0]).toMatch(/● main/u)
		expect(rows[1]).toMatch(/solo/u)
		expect(rows.at(-1)).toBe(
			`  ◯ Release audit    ${'▰'.repeat(8)}${'▱'.repeat(12)}  3/7 · 2m14s · ↓ 48.2k tokens`,
		)
	})

	it('is dim until selected, and a selected row carries the pointer at full brightness', async () => {
		const row = workflowOf(sevenAgents())
		const idle = await show([row])
		expect(idle.at(-1)).not.toContain('❯')
		await mounted?.unmount()
		mounted = undefined
		const selected = await show([row], { selectedIndex: 0 })
		expect(selected.at(-2)).toMatch(/^❯ ◯ Release audit/u)
	})

	it('colours the bullet only for an outcome, and the whole row stays dim until selected', async () => {
		const settled = (id: string, status: SubagentActivity['status']) =>
			agent({ viewId: id, status, workflow: id, workflowGroupId: id, completedAt: NOW - 1_000 })
		const rows = railWorkflows(
			[
				settled('ok', 'completed'),
				settled('bad', 'failed'),
				settled('halt', 'cancelled'),
				agent({ viewId: 'run', workflow: 'run', workflowGroupId: 'run' }),
				agent({ viewId: 'bad-run', workflow: 'bad-run', workflowGroupId: 'bad-run' }),
				agent({
					viewId: 'bad-run-2',
					workflow: 'bad-run',
					workflowGroupId: 'bad-run',
					status: 'failed',
					completedAt: NOW - 1_000,
				}),
			],
			NOW,
		)
		await show(rows)
		const painted = mounted?.writes().join('') ?? ''
		// theme.status.ok once; theme.status.error for failed, stopped and a running workflow with a failed member.
		expect(painted.match(new RegExp(`${ESC}\\[38;5;77m${ESC}\\[2m◯`, 'gu'))).toHaveLength(1)
		expect(painted.match(new RegExp(`${ESC}\\[38;5;203m${ESC}\\[2m◯`, 'gu'))).toHaveLength(3)
		// The one with nothing to report keeps the dim default.
		expect(painted.match(new RegExp(`${ESC}\\[2m◯`, 'gu'))?.length ?? 0).toBeGreaterThanOrEqual(1)
	})

	it('shows the hint for the selected workflow: stop while running, clear once done', async () => {
		const row = workflowOf(sevenAgents())
		const running = await show([row], { selectedIndex: 0 })
		expect(running.at(-1)).toContain('enter to view · x to stop')
		await mounted?.unmount()
		mounted = undefined
		const done = workflowOf([agent({ viewId: 'a', status: 'completed', completedAt: NOW })])
		const finished = await show([done], { selectedIndex: 0 })
		expect(finished.at(-1)).toContain('enter to view · x to clear')
		expect(railHint(done, 100)).toBe('↑/↓ to select · enter to view · x to clear · esc to go back')
	})

	it('folds into the main row count while a review owns the screen', async () => {
		mounted = await renderToScreen(
			<AgentTaskPanel
				agents={[agent({ viewId: 'a' })]}
				workflows={[workflowOf(sevenAgents())]}
				terminalRows={40}
				terminalColumns={100}
				now={NOW}
				compact
			/>,
			{ cols: 100, rows: 14 },
		)
		const rows = mounted.viewport().filter((row) => row.trim().length > 0)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatch(/1 agent · 1 workflow$/u)
	})
})

describe('the closing line', () => {
	const finished = (...statuses: SubagentActivity['status'][]) =>
		workflowOf(
			statuses.map((status, i) =>
				agent({
					viewId: `n${i}`,
					status,
					completedAt: NOW - 1_000,
					...(i === 0 ? { tokens: 112_000 } : {}),
				}),
			),
		)

	it('is quiet for a completed workflow, red for a failed one, yellow for a stopped one', () => {
		expect(workflowNotice(finished('completed', 'completed'))).toEqual({
			content: 'Workflow Release audit completed · 2m13s · 2 agents · 112.0k tokens',
			tone: 'ok',
			glyph: '✓',
		})
		expect(workflowNotice(finished('completed', 'failed'))).toMatchObject({
			content: 'Workflow Release audit failed · 2m13s · 2 agents · 1 failed · 112.0k tokens',
			tone: 'error',
			glyph: '✗',
		})
		expect(workflowNotice(finished('completed', 'cancelled'))).toMatchObject({
			content: expect.stringContaining('stopped'),
			tone: 'warn',
			glyph: '■',
		})
	})

	it('has no escape sequences of its own', () => {
		expect(workflowNotice(finished('completed')).content).not.toContain(ESC)
	})
})
