/**
 * The agents rail: a `main` row, then one row per running or recently
 * finished sub-agent. Rows, the five-row window, the 30 s lifetime of a
 * finished agent and the key line are checked here; the keys themselves are
 * driven through the real terminal in the pty lab (see docs/cli/terminal-design.md).
 */

import { createRequire } from 'node:module'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Box } from 'ink'

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
		// The app's own one cell of side padding, which the rail reaches into.
		<Box flexDirection="column" paddingX={1}>
			<AgentTaskPanel
				agents={agents}
				terminalRows={40}
				terminalColumns={cols}
				now={NOW}
				{...(props.selectedIndex !== undefined ? { selectedIndex: props.selectedIndex } : {})}
				{...(props.viewingId !== undefined ? { viewingId: props.viewingId } : {})}
				{...(props.compact ? { compact: true } : {})}
			/>
		</Box>,
		{ cols, rows: 14 },
	)
	lastScreen = mounted.viewport()
	return lastScreen.filter((row) => row.trim().length > 0)
}

/** Every row of the last screen shown, blank ones included. */
let lastScreen: readonly string[] = []

describe('which agents the rail lists', () => {
	it('drops a background agent the moment it completes, and keeps a failed or stopped one 30 seconds', () => {
		const rows = railAgents(
			[
				agent({
					viewId: 'bg-done',
					background: true,
					status: 'completed',
					completedAt: NOW - 1,
				}),
				agent({
					viewId: 'bg-failed',
					background: true,
					status: 'failed',
					completedAt: NOW - 5_000,
				}),
				agent({
					viewId: 'bg-stopped',
					background: true,
					status: 'cancelled',
					completedAt: NOW - 5_000,
				}),
				agent({
					viewId: 'fg-done',
					status: 'completed',
					completedAt: NOW - 5_000,
				}),
				agent({
					viewId: 'bg-late',
					background: true,
					status: 'failed',
					completedAt: NOW - 31_000,
				}),
				agent({ viewId: 'bg-running', background: true }),
			],
			NOW,
		)
		expect(rows.map((row) => row.viewId).sort()).toEqual(
			['bg-failed', 'bg-running', 'bg-stopped', 'fg-done'].sort(),
		)
	})

	it('does not wait to evict a background agent that completed, and still times the others', () => {
		expect(
			railNextEviction(
				[
					agent({
						viewId: 'bg',
						background: true,
						status: 'completed',
						completedAt: NOW - 1,
					}),
				],
				NOW,
			),
		).toBeUndefined()
		expect(
			railNextEviction(
				[
					agent({
						viewId: 'bg',
						background: true,
						status: 'failed',
						completedAt: NOW - 10_000,
					}),
				],
				NOW,
			),
		).toBe(AGENT_RAIL_FINISHED_LINGER_MS - 10_000)
	})

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
				agent({
					viewId: 'old-done',
					status: 'completed',
					startedAt: 2,
					completedAt: NOW - 31_000,
				}),
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
					agent({
						viewId: 'a',
						status: 'completed',
						completedAt: NOW - 10_000,
					}),
					agent({
						viewId: 'b',
						status: 'completed',
						completedAt: NOW - 20_000,
					}),
					agent({
						viewId: 'gone',
						status: 'completed',
						completedAt: NOW - 40_000,
					}),
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
			agent({
				viewId: 'b',
				agentId: 'explore',
				description: 'Find the footer',
				status: 'queued',
			}),
		])
		expect(rows[0]).toMatch(/^ {2}● main$/u)
		expect(rows[1]).toMatch(
			/^ {2}◯ general-purpose {2,}Mine the UI reference\s+12s · ↓ 3\.2k tokens$/u,
		)
		expect(rows[2]).toMatch(/^ {2}◯ explore {2,}Find the footer\s+waiting$/u)
		expect(rows).toHaveLength(3)
		expect(rows.join('\n')).not.toContain('Delegated work')
	})

	it('names each agent by its job, so two of one type are told apart', async () => {
		const rows = await show([
			agent({
				viewId: 'a',
				agentId: 'count-words',
				description: 'Count words in a.txt',
			}),
			agent({
				viewId: 'b',
				agentId: 'list-files',
				description: 'List files in project directory',
			}),
			agent({ viewId: 'c', description: 'Saved one' }),
		])
		expect(rows[1]).toMatch(/^ {2}◯ count-words {2,}Count words in a\.txt\s+12s$/u)
		expect(rows[2]).toMatch(/^ {2}◯ list-files {2,}List files in project directory\s+12s$/u)
		// No name: the type is the fallback.
		expect(rows[3]).toMatch(/^ {2}◯ general-purpose {2,}Saved one\s+12s$/u)
	})

	it('shows what the agent is doing while it runs, and what it was asked once it ended', async () => {
		const live = await show([
			agent({
				viewId: 'a',
				agentId: 'count-words',
				description: 'Count words',
				summary: 'Read(a.txt)',
			}),
		])
		expect(live[1]).toMatch(/^ {2}◯ count-words {2,}Read\(a\.txt\)\s+12s$/u)
		await mounted?.unmount()
		const done = await show([
			agent({
				viewId: 'a',
				agentId: 'count-words',
				description: 'Count words',
				summary: 'Read(a.txt)',
				status: 'failed',
				completedAt: NOW - 1_000,
			}),
		])
		expect(done[1]).toMatch(/^ {2}◯ count-words {2,}Count words\s+11s$/u)
	})

	it('puts a blank row above the rail, the bullet two cells in, and ends rows two cells short of the edge', async () => {
		await show([agent({ viewId: 'a', agentId: 'count-words', description: 'Count words' })], {
			cols: 100,
		})
		expect(lastScreen[0]?.trim()).toBe('')
		expect(lastScreen[1]).toMatch(/^ {2}● main/u)
		const row = lastScreen[2] ?? ''
		expect(row.indexOf('◯')).toBe(2)
		// The status block ends at column 98 of 100: its last character is at index 97.
		expect(row.trimEnd().length).toBe(98)
	})

	it('shares one name column between agent rows and a workflow row', async () => {
		mounted = await renderToScreen(
			<Box flexDirection="column" paddingX={1}>
				<AgentTaskPanel
					agents={[
						agent({
							viewId: 'a',
							agentId: 'count-words',
							description: 'Count words',
						}),
					]}
					workflows={[
						{
							id: 'g',
							focusId: 'workflow:g',
							name: 'read-and-summarize-txt',
							startedAt: NOW - 12_000,
							done: 0,
							total: 2,
							failed: 0,
							status: 'running',
							agents: [],
						},
					]}
					terminalRows={40}
					terminalColumns={100}
					now={NOW}
				/>
			</Box>,
			{ cols: 100, rows: 14 },
		)
		const rows = mounted.viewport().filter((row) => row.trim().length > 0)
		// Name column is as wide as the longest name (22), the description starts two cells later.
		expect(rows[1]?.indexOf('Count words')).toBe(4 + 22 + 2)
		expect(rows[2]?.indexOf('▱')).toBe(4 + 22 + 2)
	})

	it('draws no accent colour: the pointer and bullets use the row colour', async () => {
		await show(
			[
				agent({ viewId: 'a', agentId: 'count-words' }),
				agent({ viewId: 'b', agentId: 'list-files' }),
			],
			{ selectedIndex: 1 },
		)
		const painted = mounted?.writes().join('') ?? ''
		// theme.accent.assistant is ansi256(83); nothing on the rail uses it.
		expect(painted).not.toContain(`${ESC}[38;5;83m`)
		expect(painted).toContain('❯')
	})

	it('shows no spend before the agent has reported usage, and the total once it finished', () => {
		expect(railStatusText(agent({ viewId: 'a' }), NOW)).toBe('12s')
		expect(
			railStatusText(
				agent({
					viewId: 'a',
					status: 'completed',
					completedAt: NOW - 2_000,
					tokens: 950,
				}),
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
		expect(selected[2]).toMatch(/^❯ ◯ general-purpose {2,}Second/u)
		await mounted?.unmount()
		const viewing = await show(agents, { viewingId: 'a' })
		expect(viewing[0]).toMatch(/^ {2}◯ main/u)
		expect(viewing[1]).toMatch(/^ {2}● general-purpose {2,}First/u)
	})

	it('colours the bullet only for a finished agent, green when it succeeded and red when it failed or was stopped', async () => {
		const done = agent({
			viewId: 'a',
			status: 'completed',
			completedAt: NOW - 1_000,
		})
		const failed = agent({
			viewId: 'b',
			status: 'failed',
			completedAt: NOW - 1_000,
		})
		const stopped = agent({
			viewId: 'd',
			status: 'cancelled',
			completedAt: NOW - 1_000,
		})
		const running = agent({ viewId: 'c' })
		const rows = await show([done, failed, stopped, running])
		expect(rows).toHaveLength(5)
		const painted = mounted?.writes().join('') ?? ''
		// theme.status.ok once, theme.status.error twice (failed, stopped): the running row has none.
		expect(painted.match(new RegExp(`${ESC}\\[38;5;77m◯`, 'gu'))).toHaveLength(1)
		expect(painted.match(new RegExp(`${ESC}\\[38;5;203m◯`, 'gu'))).toHaveLength(2)
		expect(railActionFor(done)).toBe('clear')
		expect(railActionFor(failed)).toBe('clear')
		expect(railActionFor(running)).toBe('stop')
	})

	it('is a single row with a count while a review owns the screen', async () => {
		const rows = await show([agent({ viewId: 'a' }), agent({ viewId: 'b' })], {
			compact: true,
		})
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
		expect(rows.at(-1)).toMatch(/^ {2}↓ 3 more$/u)
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

	it('keeps a row where "↓ N more" was when nothing is below, so the block does not change height', async () => {
		const six = Array.from({ length: 6 }, (_, i) =>
			agent({ viewId: `a${i}`, description: `Worker ${i}`, startedAt: i }),
		)
		// Selected row 6 (the sixth agent): the window has moved to the end.
		await show(six, { selectedIndex: 6 })
		const atEnd = lastScreen.findIndex((row) => row.includes('Worker 5'))
		expect(lastScreen[atEnd + 1]?.trim()).toBe('')
		const heightAtEnd = lastScreen.filter((row) => row.trim().length > 0).length
		await mounted?.unmount()
		await show(six, { selectedIndex: 1 })
		// At the top the "↓ 1 more" row stands where the spare row was.
		expect(lastScreen.some((row) => /^ {2}↓ 1 more$/u.test(row))).toBe(true)
		const heightAtTop = lastScreen.filter((row) => row.trim().length > 0).length
		expect(heightAtTop).toBe(heightAtEnd + 1)
		// Five agents or fewer: no spare row at all.
		await mounted?.unmount()
		await show(six.slice(0, 5))
		const rowsShown = lastScreen.findIndex((row) => row.includes('Worker 4'))
		expect(lastScreen.slice(rowsShown + 1).every((row) => row.trim() === '')).toBe(true)
	})
})

describe('the key line', () => {
	it('says stop for a running agent and clear for a finished one, and nothing about leaving', () => {
		expect(railHint(agent({ viewId: 'a' }), 140)).toBe('Enter to view · x to stop')
		expect(railHint(agent({ viewId: 'a', status: 'failed', completedAt: NOW }), 140)).toBe(
			'Enter to view · x to clear',
		)
		expect(railHint(undefined, 140)).toBe('↑/↓ to select · Enter to view')
		expect(railHint(agent({ viewId: 'a' }), 140)).not.toMatch(/esc/iu)
	})

	it('offers to stop all agents only when more than one runs and the line is wide enough', () => {
		expect(railHint(agent({ viewId: 'a' }), 140, 2)).toBe(
			'Enter to view · x to stop · ctrl+x ctrl+k to stop all agents',
		)
		expect(railHint(agent({ viewId: 'a' }), 140, 1)).toBe('Enter to view · x to stop')
		expect(railHint(agent({ viewId: 'a' }), 89, 2)).toBe('Enter to view · x to stop')
	})

	it('is not drawn by the rail itself: it replaces the footer line', async () => {
		const focused = await show([agent({ viewId: 'a' })], { selectedIndex: 1 })
		expect(focused.join('\n')).not.toContain('to stop')
		expect(focused.join('\n')).toContain('❯')
	})
})
