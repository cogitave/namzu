/**
 * The agents rail: a `main` row, then one row per running or recently
 * finished sub-agent. Rows, the five-row window, the 30 s lifetime of a
 * finished agent and the key line are checked here; the keys themselves are
 * driven through the real terminal in the pty lab (see docs/cli/terminal-design.md).
 */

import { createRequire } from 'node:module'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import {
	AGENT_RAIL_FINISHED_LINGER_MS,
	AGENT_RAIL_WINDOW,
	AgentTaskPanel,
	railActionFor,
	railAgents,
	railHint,
	railNextEviction,
	railStatusText,
} from '../AgentExplorer.js'
import { type Screen, renderToScreen } from './support/screen.js'

const NOW = 100_000
const ESC = String.fromCharCode(27)

// The test terminal is a colour TTY; the Vitest process itself usually is not.
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
		workflowGroupId: 'group-1',
		phaseId: 'phase-1',
		workflow: 'Delegated work',
		phase: 'Work',
		phaseSequence: 0,
		status: 'working',
		startedAt: NOW - 12_000,
		transcript: [],
		...input,
	}
}

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

async function show(
	agents: readonly SubagentActivity[],
	props: {
		selectedIndex?: number
		viewingId?: string | null
		compact?: boolean
		cols?: number
	} = {},
) {
	const cols = props.cols ?? 100
	mounted = await renderToScreen(
		<AgentTaskPanel
			agents={agents}
			terminalRows={40}
			terminalColumns={cols}
			now={NOW}
			{...(props.selectedIndex !== undefined ? { selectedIndex: props.selectedIndex } : {})}
			{...(props.viewingId !== undefined ? { viewingId: props.viewingId } : {})}
			{...(props.compact ? { compact: true } : {})}
		/>,
		{ cols, rows: 14 },
	)
	return mounted.viewport().filter((row) => row.trim().length > 0)
}

describe('which agents the rail lists', () => {
	it('keeps running agents and finished ones for 30 seconds, oldest launch first', () => {
		const rows = railAgents(
			[
				agent({ viewId: 'late', startedAt: 5 }),
				agent({
					viewId: 'fresh-done',
					status: 'completed',
					startedAt: 1,
					completedAt: NOW - 29_000,
				}),
				agent({ viewId: 'old-done', status: 'completed', startedAt: 2, completedAt: NOW - 31_000 }),
				agent({ viewId: 'early', startedAt: 3 }),
			],
			NOW,
		)
		expect(rows.map((row) => row.viewId)).toEqual(['fresh-done', 'early', 'late'])
	})

	it('leaves out saved children, cleared agents and finished ones with no end time', () => {
		const rows = railAgents(
			[
				agent({ viewId: 'saved', replayed: true }),
				agent({ viewId: 'cleared', status: 'failed', completedAt: NOW }),
				agent({ viewId: 'no-end', status: 'completed' }),
				agent({ viewId: 'kept' }),
			],
			NOW,
			new Set(['cleared']),
		)
		expect(rows.map((row) => row.viewId)).toEqual(['kept'])
	})

	it('names how long until the next finished agent leaves, and nothing when none will', () => {
		expect(railNextEviction([agent({ viewId: 'running' })], NOW)).toBeUndefined()
		expect(
			railNextEviction(
				[
					agent({ viewId: 'a', status: 'completed', completedAt: NOW - 10_000 }),
					agent({ viewId: 'b', status: 'completed', completedAt: NOW - 20_000 }),
					agent({ viewId: 'gone', status: 'completed', completedAt: NOW - 40_000 }),
				],
				NOW,
			),
		).toBe(AGENT_RAIL_FINISHED_LINGER_MS - 20_000)
	})
})

describe('rail rows', () => {
	it('draws main first and one row per agent with its type, description, clock and spend', async () => {
		const rows = await show([
			agent({
				viewId: 'a',
				agentId: 'general-purpose',
				description: 'Mine the UI reference',
				tokens: 3_210,
			}),
			agent({ viewId: 'b', agentId: 'explore', description: 'Find the footer', status: 'queued' }),
		])
		expect(rows[0]).toMatch(/^ {2}● main\s+↓ to manage$/u)
		expect(rows[1]).toMatch(
			/^ {2}○ general-purpose {2,}Mine the UI reference\s+12s · ↓ 3\.2k tokens$/u,
		)
		expect(rows[2]).toMatch(/^ {2}○ explore {2,}Find the footer\s+waiting$/u)
		expect(rows).toHaveLength(3)
		expect(rows.join('\n')).not.toContain('Delegated work')
	})

	it('shows no spend before the agent has reported usage, and the total once it finished', () => {
		expect(railStatusText(agent({ viewId: 'a' }), NOW)).toBe('12s')
		expect(
			railStatusText(
				agent({ viewId: 'a', status: 'completed', completedAt: NOW - 2_000, tokens: 950 }),
				NOW,
			),
		).toBe('10s · ↓ 950 tokens')
	})

	it('points at the selected row and moves the open circle to the agent being viewed', async () => {
		const agents = [
			agent({ viewId: 'a', description: 'First' }),
			agent({ viewId: 'b', description: 'Second' }),
		]
		const selected = await show(agents, { selectedIndex: 2 })
		expect(selected[0]).toMatch(/^ {2}● main\s*$/u)
		expect(selected[2]).toMatch(/^❯ ○ general-purpose {2,}Second/u)
		await mounted?.unmount()
		const viewing = await show(agents, { viewingId: 'a' })
		expect(viewing[0]).toMatch(/^ {2}○ main/u)
		expect(viewing[1]).toMatch(/^ {2}● general-purpose {2,}First/u)
	})

	it('colours the bullet only for a finished agent, green when it succeeded and red when it failed or was stopped', async () => {
		const done = agent({ viewId: 'a', status: 'completed', completedAt: NOW - 1_000 })
		const failed = agent({ viewId: 'b', status: 'failed', completedAt: NOW - 1_000 })
		const stopped = agent({ viewId: 'd', status: 'cancelled', completedAt: NOW - 1_000 })
		const running = agent({ viewId: 'c' })
		const rows = await show([done, failed, stopped, running])
		expect(rows).toHaveLength(5)
		const painted = mounted?.writes().join('') ?? ''
		// theme.status.ok once, theme.status.error twice (failed, stopped): the running row has none.
		expect(painted.match(new RegExp(`${ESC}\\[38;5;77m${ESC}\\[2m○`, 'gu'))).toHaveLength(1)
		expect(painted.match(new RegExp(`${ESC}\\[38;5;203m${ESC}\\[2m○`, 'gu'))).toHaveLength(2)
		expect(railActionFor(done)).toBe('clear')
		expect(railActionFor(failed)).toBe('clear')
		expect(railActionFor(running)).toBe('stop')
	})

	it('is a single row with a count while a review owns the screen', async () => {
		const rows = await show([agent({ viewId: 'a' }), agent({ viewId: 'b' })], { compact: true })
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatch(/^ {2}● main\s+2 agents$/u)
	})
})

describe('window and overflow', () => {
	const many = Array.from({ length: 8 }, (_, i) =>
		agent({ viewId: `a${i}`, description: `Worker ${i}`, startedAt: i }),
	)

	it('shows five agents and counts the rest below', async () => {
		expect(AGENT_RAIL_WINDOW).toBe(5)
		const rows = await show(many)
		expect(rows.filter((row) => /Worker/u.test(row))).toHaveLength(5)
		expect(rows.at(-1)).toMatch(/^ {4}↓ 3 more$/u)
		expect(rows.join('\n')).toContain('Worker 0')
		expect(rows.join('\n')).not.toContain('Worker 5')
	})

	it('scrolls with the selection and counts what is above on the main row', async () => {
		const rows = await show(many, { selectedIndex: 8 })
		expect(rows[0]).toMatch(/^ {2}● main\s+↑ 3 more$/u)
		expect(rows.join('\n')).toContain('Worker 7')
		expect(rows.join('\n')).not.toContain('Worker 0')
		expect(rows.join('\n')).not.toMatch(/↓ \d+ more/u)
		expect(rows.join('\n')).toContain('❯')
	})
})

describe('the key line', () => {
	it('says stop for a running agent and clear for a finished one', () => {
		expect(railHint(agent({ viewId: 'a' }), 100)).toBe(
			'↑/↓ to select · enter to view · x to stop · esc to go back',
		)
		expect(railHint(agent({ viewId: 'a', status: 'completed', completedAt: NOW }), 100)).toBe(
			'↑/↓ to select · enter to view · x to clear · esc to go back',
		)
		expect(railHint(undefined, 100)).toBe('↑/↓ to select · enter to view · esc to go back')
	})

	it('drops hints before it wraps', () => {
		const text = railHint(agent({ viewId: 'a' }), 30)
		expect(text.length).toBeLessThanOrEqual(28)
		expect(text).toContain('enter')
	})

	it('appears under the rows only while the rail is focused', async () => {
		const unfocused = await show([agent({ viewId: 'a' })])
		expect(unfocused.join('\n')).not.toContain('x to stop')
		await mounted?.unmount()
		const focused = await show([agent({ viewId: 'a' })], { selectedIndex: 1 })
		expect(focused.at(-1)).toContain('x to stop')
	})
})
