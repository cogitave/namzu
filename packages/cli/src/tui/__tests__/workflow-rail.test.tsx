/**
 * Workflow rows on the agents rail: one row per `workflow` label, drawn after
 * the agent rows as `◯ name  ▰▱ bar  3/7 · 2m 14s · ↓ 48.2k tokens`. Which
 * workflows are listed, how a row narrows, the bullet's colours, the 30 s
 * lifetime and the key line are checked here; Enter, `x` and Esc go through
 * the real terminal in the pty lab (see docs/cli/terminal-design.md).
 */

import { createRequire } from 'node:module'

import { Box } from 'ink'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import { initialRunView } from '../../integrations/workflows/view.js'
import {
	AGENT_RAIL_FINISHED_LINGER_MS,
	AgentTaskPanel,
	type RailWorkflow,
	layoutWorkflowRow,
	railProgressBar,
	railWorkflowActionFor,
	railWorkflowBulletColor,
	railWorkflows,
	workflowRowVariants,
} from '../AgentExplorer.js'
import {
	workflowAgentProgress,
	workflowAgentTotal,
	workflowNotice,
} from '../agent-transcript-rows.js'
import { theme } from '../theme.js'
import { type Screen, renderToScreen } from './support/screen.js'

const NOW = 1_000_000
const ESC = String.fromCharCode(27)

const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as {
	level: number
}
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
	props: {
		selectedIndex?: number
		cols?: number
		agents?: readonly SubagentActivity[]
	} = {},
) {
	const cols = props.cols ?? 100
	mounted = await renderToScreen(
		<Box flexDirection="column" paddingX={1}>
			<AgentTaskPanel
				agents={props.agents ?? []}
				workflows={workflows}
				terminalRows={40}
				terminalColumns={cols}
				now={NOW}
				{...(props.selectedIndex !== undefined ? { selectedIndex: props.selectedIndex } : {})}
			/>
		</Box>,
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
		const ended = {
			...base,
			status: 'failed' as const,
			endedAt: NOW,
			error: 'boom',
		}
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
				agent({
					viewId: 'b',
					workflow: 'Second',
					workflowGroupId: 'g2',
					startedAt: 9,
				}),
				agent({
					viewId: 'a',
					workflow: 'First',
					workflowGroupId: 'g1',
					startedAt: 3,
				}),
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
			{ barWidth: 20, text: '3/7 · 2m 14s · ↓ 48.2k tokens' },
			{ barWidth: 20, text: '2m 14s · ↓ 48.2k tokens' },
			{ barWidth: 20, text: '2m 14s · ↓ 48.2k' },
			{ barWidth: 20, text: '↓ 48.2k' },
			{ barWidth: 12, text: '↓ 48.2k' },
			{ barWidth: 8, text: '↓ 48.2k' },
			{ barWidth: 8, text: '' },
		])
	})

	it('puts the large-run warning first, then the short form, and drops it as the row narrows', () => {
		const large: RailWorkflow = { ...row, large: true }
		const texts = workflowRowVariants(large, NOW).map((variant) => variant.text)
		expect(texts.slice(0, 3)).toEqual([
			'3/7 · 2m 14s · ↓ 48.2k tokens · Large workflow · /workflows to stop',
			'3/7 · 2m 14s · ↓ 48.2k tokens · Large workflow',
			'2m 14s · ↓ 48.2k · Large workflow',
		])
		expect(texts.slice(3)).toEqual(workflowRowVariants(row, NOW).map((variant) => variant.text))
	})

	it('leaves the failure out of the counter: a failed run reads the same as a clean one', () => {
		const withFailure: RailWorkflow = { ...row, failed: 1 }
		expect(workflowRowVariants(withFailure, NOW)).toEqual(workflowRowVariants(row, NOW))
		expect(workflowRowVariants(withFailure, NOW)[0]?.text).toBe('3/7 · 2m 14s · ↓ 48.2k tokens')
	})

	it.each([
		[100, '3/7 · 2m 14s · ↓ 48.2k tokens'],
		[60, '2m 14s · ↓ 48.2k tokens'],
	])('draws a failed run with no failure text at %i columns', (columns, text) => {
		const withFailure: RailWorkflow = { ...row, failed: 1 }
		const { variant } = layoutWorkflowRow(withFailure, NOW, columns, 4)
		expect(variant.text).toBe(text)
		expect(variant.text).not.toContain('failed')
	})

	it('turns the dot of a run with a failed agent red, finished or still going', () => {
		expect(railWorkflowBulletColor({ ...row, failed: 1 })).toBe(theme.status.error)
		expect(railWorkflowBulletColor({ ...row, failed: 1, status: 'failed' })).toBe(
			theme.status.error,
		)
	})
})

describe('the closing line', () => {
	// `done` counts the agents that completed, so a failed one is not in it.
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
			content: 'Workflow Release audit finished · 2m 13s · 2 agents · 112.0k tokens',
			tone: 'ok',
			glyph: '●',
		})
		expect(workflowNotice(finished('completed', 'failed'))).toMatchObject({
			content: 'Workflow Release audit failed · 2m 13s · 2 agents · 112.0k tokens',
			tone: 'error',
			glyph: '●',
		})
		expect(workflowNotice(finished('completed', 'cancelled'))).toMatchObject({
			content: expect.stringContaining('stopped'),
			tone: 'warn',
			glyph: '●',
		})
	})

	it('counts every agent a run had, failed or not, and never splits it', () => {
		const run: RailWorkflow = {
			...finished('completed', 'completed', 'failed'),
			done: 2,
			total: 3,
			failed: 1,
		}
		expect(workflowNotice(run).content).toBe(
			'Workflow Release audit failed · 2m 13s · 3 agents · 112.0k tokens',
		)
	})

	it('says the total in the closing line and done over total in the list', () => {
		expect(workflowAgentTotal(3)).toBe('3 agents')
		expect(workflowAgentTotal(1)).toBe('1 agent')
		expect(workflowAgentProgress({ done: 2, total: 3 })).toBe('2/3 agents')
		expect(workflowAgentProgress({ done: 3, total: 3 })).toBe('3/3 agents')
		expect(workflowAgentProgress({ done: 0, total: 1 })).toBe('0/1 agent')
	})

	it('has no escape sequences of its own', () => {
		expect(workflowNotice(finished('completed')).content).not.toContain(ESC)
	})
})
