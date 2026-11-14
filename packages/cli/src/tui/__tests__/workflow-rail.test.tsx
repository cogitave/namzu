/**
 * Workflow rows on the agents rail: one row per `workflow` label, drawn after
 * the agent rows as `◯ name  ▰▱ bar  3/7 · 2m14s · ↓ 48.2k tokens`. Which
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
	railTypedText,
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
			// What the agent wrote is the number shown; what it was sent again on
			// every request (the cumulative figure) is far larger and never is.
			...(i === 0 ? { tokens: 900_000, outputTokens: 48_200 } : {}),
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
		<Box flexDirection="column" paddingLeft={0} paddingRight={1}>
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
			tokens: 900_000,
			outputTokens: 48_200,
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

	const full = '3/7 · 2m14s · ↓ 48.2k tokens'

	it('never puts the cumulative figure in the row, only what the agents wrote', () => {
		for (const variant of workflowRowVariants(row, NOW)) expect(variant.text).not.toContain('900')
		const silent = workflowOf(sevenAgents().map(({ outputTokens: _, ...rest }) => rest))
		for (const variant of workflowRowVariants(silent, NOW))
			expect(variant.text).not.toContain('tokens')
	})

	it('lists the variants from the full block to the short bar with the counter and the clock', () => {
		expect(workflowRowVariants(row, NOW)).toEqual([
			{ barWidth: 20, text: full },
			{ barWidth: 12, text: full },
			{ barWidth: 8, text: full },
			{ barWidth: 4, text: full },
			{ barWidth: 4, text: '3/7 · 2m14s' },
			{ barWidth: 0, text: '3/7 · 2m14s' },
			{ barWidth: 0, text: '3/7' },
		])
	})

	it('keeps the two-word large mark until the tokens are gone and the name is next', () => {
		const large: RailWorkflow = { ...row, large: true }
		const marked = `${full} · Large workflow`
		expect(workflowRowVariants(large, NOW)).toEqual([
			{ barWidth: 20, text: marked },
			{ barWidth: 12, text: marked },
			{ barWidth: 8, text: marked },
			{ barWidth: 4, text: marked },
			{ barWidth: 4, text: '3/7 · 2m14s · Large workflow' },
			{ barWidth: 4, text: '3/7 · 2m14s' },
			{ barWidth: 0, text: '3/7 · 2m14s' },
			{ barWidth: 0, text: '3/7' },
		])
	})

	it('names the phases running now only in the widest variants: two titles, then how many more', () => {
		const phases = (...titles: string[]): RailWorkflow => ({
			...row,
			runningPhases: titles,
		})
		const texts = (flow: RailWorkflow) =>
			workflowRowVariants(flow, NOW).map((variant) => variant.text)
		expect(texts(phases('Scan')).slice(0, 2)).toEqual([`${full} · Scan`, full])
		expect(texts(phases('Scan', 'Check')).slice(0, 3)).toEqual([
			`${full} · Scan, Check`,
			`${full} · Scan +1 more`,
			full,
		])
		expect(texts(phases('Scan', 'Check', 'Fix', 'Ship')).slice(0, 2)).toEqual([
			`${full} · Scan, Check +2 more`,
			`${full} · Scan +3 more`,
		])
		// Only the first variants carry them: the bar has not yet shrunk.
		expect(
			workflowRowVariants(phases('Scan', 'Check'), NOW)
				.filter((variant) => variant.text.includes('Scan'))
				.map((variant) => variant.barWidth),
		).toEqual([20, 20])
	})

	it('cuts a long phase title with an ellipsis', () => {
		const texts = workflowRowVariants(
			{
				...row,
				runningPhases: ['A very long phase title that goes on and on'],
			},
			NOW,
		).map((variant) => variant.text)
		expect(texts[0]).toMatch(/· A very long phase…$/u)
	})

	// The breakpoints: columns at which the row gives something up. The name
	// is `Release audit` (13 cells) and stays whole until the last step.
	it.each([
		[120, 20, full, 13],
		[69, 20, full, 13],
		[68, 12, full, 13],
		[61, 12, full, 13],
		[60, 8, full, 13],
		[57, 8, full, 13],
		[56, 4, full, 13],
		[53, 4, full, 13],
		[52, 4, '3/7 · 2m14s', 13],
		[36, 4, '3/7 · 2m14s', 13],
		[35, 4, '3/7 · 2m14s', 12],
		[31, 4, '3/7 · 2m14s', 8],
		[30, 0, '3/7 · 2m14s', 11],
		[27, 0, '3/7 · 2m14s', 8],
		[26, 0, '3/7', 13],
		[12, 0, '3/7', 1],
	])('at %i columns: a %i-cell bar, %j, a name of %i cells', (columns, bar, text, name) => {
		const { variant, nameWidth } = layoutWorkflowRow(row, NOW, columns, 13)
		expect({
			bar: variant.barWidth,
			text: variant.text,
			name: nameWidth,
		}).toEqual({
			bar,
			text,
			name,
		})
	})

	it('gives up space in the brief order: bar, then tokens, then name, counter and clock last', () => {
		const withPhases: RailWorkflow = {
			...row,
			runningPhases: ['Scan', 'Check'],
		}
		const at = (columns: number) => layoutWorkflowRow(withPhases, NOW, columns, 13)
		expect(at(120).variant.text).toContain('Scan, Check')
		// 100 columns: no room to spare for the phases; the bar is still whole.
		expect(at(80).variant.text).toBe(full)
		expect(at(80).variant.barWidth).toBe(20)
		expect(at(57).variant.barWidth).toBe(8)
		expect(at(57).variant.text).toContain('↓ 48.2k tokens')
		expect(at(52).variant.text).not.toContain('tokens')
		expect(at(52).variant.text).toContain('3/7 · 2m14s')
		expect(at(52).nameWidth).toBe(13)
		expect(at(33).nameWidth).toBeLessThan(13)
		expect(at(33).variant.text).toContain('3/7 · 2m14s')
	})

	it.each([100, 80, 60, 50, 40])('draws the counter and the clock at %i columns', async (cols) => {
		const lines = await show([row], { cols })
		const flow = lines.find((line) => line.includes('◯')) ?? ''
		expect(flow).toContain('3/7')
		expect(flow).toContain('2m14s')
		expect(flow.length).toBeLessThanOrEqual(cols)
	})

	it('leaves the failure out of the counter: a failed run reads the same as a clean one', () => {
		const withFailure: RailWorkflow = { ...row, failed: 1 }
		expect(workflowRowVariants(withFailure, NOW)).toEqual(workflowRowVariants(row, NOW))
		expect(workflowRowVariants(withFailure, NOW)[0]?.text).toBe('3/7 · 2m14s · ↓ 48.2k tokens')
	})

	it.each([
		[100, '3/7 · 2m14s · ↓ 48.2k tokens'],
		[60, '3/7 · 2m14s · ↓ 48.2k tokens'],
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
					...(i === 0 ? { tokens: 3_000_000, outputTokens: 112_000 } : {}),
				}),
			),
		)

	it('is quiet for a completed workflow, red for a failed one, yellow for a stopped one', () => {
		expect(workflowNotice(finished('completed', 'completed'))).toEqual({
			content: 'Workflow Release audit finished · 2m 13s · 2 agents · 112.0k tokens written',
			tone: 'ok',
			glyph: '●',
		})
		expect(workflowNotice(finished('completed', 'failed'))).toMatchObject({
			content: 'Workflow Release audit failed · 2m 13s · 2 agents · 112.0k tokens written',
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
			'Workflow Release audit failed · 2m 13s · 3 agents · 112.0k tokens written',
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

describe('the keys the rail row does not own', () => {
	it('hands a slash and any printable text to the input box', () => {
		expect(railTypedText('/', {})).toBe('/')
		expect(railTypedText('w', {})).toBe('w')
		expect(railTypedText('é', {})).toBe('é')
		expect(railTypedText('pasted words', {})).toBe('pasted words')
	})

	it('keeps control and editing keys to itself', () => {
		for (const key of [
			{ escape: true },
			{ return: true },
			{ tab: true },
			{ backspace: true },
			{ delete: true },
			{ upArrow: true },
			{ downArrow: true },
			{ leftArrow: true },
			{ rightArrow: true },
			{ pageUp: true },
			{ pageDown: true },
			{ home: true },
			{ end: true },
		])
			expect(railTypedText('x', key)).toBeUndefined()
		expect(railTypedText('c', { ctrl: true })).toBeUndefined()
		expect(railTypedText('b', { meta: true })).toBeUndefined()
		expect(railTypedText('', {})).toBeUndefined()
		expect(railTypedText('\u0003', {})).toBeUndefined()
		expect(railTypedText('a\u001bb', {})).toBeUndefined()
	})
})
