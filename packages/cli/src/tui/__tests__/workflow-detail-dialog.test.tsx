/**
 * The workflow detail dialog: frameless, a rule on top, the name, the
 * description with `done/total agents · elapsed` on its right, then the phases
 * and the agents of the selected one, side by side from 64 columns and stacked
 * below.
 */

import { Box } from 'ink'
import { afterEach, describe, expect, it } from 'vitest'

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import {
	AgentCockpit,
	type AgentCockpitFocus,
	windowTag,
	workflowDetailPageSize,
} from '../AgentExplorer.js'
import { launchLabel, launchReceipt } from '../agent-transcript-rows.js'
import { type Screen, renderToScreen } from './support/screen.js'

function member(
	viewId: string,
	phase: string,
	order: number,
	extra: Partial<SubagentActivity> = {},
): SubagentActivity {
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
		tokens: 35_600,
		model: 'gpt-x',
		transcript: [],
		...extra,
	}
}

const agents = [
	member('a1', 'Read', 0),
	member('a2', 'Read', 0, { completedAt: 7_000 }),
	member('a3', 'Summarize', 1, { status: 'working', completedAt: undefined }),
]

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

async function open(focus: AgentCockpitFocus, cols: number, rows: number, selected = 'a1') {
	const phase = agents.find((agent) => agent.viewId === selected) ?? (agents[0] as SubagentActivity)
	mounted = await renderToScreen(
		<Box flexDirection="column" paddingX={1}>
			<AgentCockpit
				agents={agents}
				selectedPhaseId={phase.phaseId}
				selectedId={phase.viewId}
				focus={focus}
				terminalRows={rows}
				terminalColumns={cols}
			/>
		</Box>,
		{ cols, rows },
	)
	return mounted.viewport()
}

describe('at 140 columns', () => {
	it('draws a rule, the header, and the two panes of one box', async () => {
		const screen = await open('phases', 140, 45)
		const text = screen.join('\n')
		expect(text).toContain('─'.repeat(100))
		const header = screen.findIndex((row) => row.trim() === 'Release audit')
		expect(header).toBeGreaterThan(0)
		expect(screen[header - 1]).toMatch(/^─+$/u)
		expect(screen[header + 1]).toMatch(/2\/3 agents · \d+(?:[dhm] \d+)*[dhms]?\s*$/u)
		expect(text).toMatch(/╭ Phases ─+┬ Read · 2 agents · 2 done ─+╮/u)
		expect(text).toMatch(
			/│ ❯ ✔ Read\s+2\/2 │ {2}✔ label a1\s+general-purpose · gpt-x · 35\.6k tok\s+23s │/u,
		)
		expect(text).toMatch(/│\s+2 Summarize\s+0\/1 │/u)
		expect(text).toMatch(/╰─+┴─+╯/u)
		expect(screen.at(-1)?.trim()).toBe('')
		expect(text).toContain('↑↓ select · x stop workflow · esc back')
		expect(text).not.toContain('enter view')
	})

	it('moves the pointer into the agents and changes the footer', async () => {
		const screen = await open('agents', 140, 45)
		const text = screen.join('\n')
		expect(text).toMatch(/│\s+✔ Read\s+2\/2 │❯ ✔ label a1/u)
		expect(text).toContain('↑↓ select · enter view · esc back')
		const running = (await open('agents', 140, 45, 'a3')).join('\n')
		expect(running).toContain('↑↓ select · enter view · x stop · esc back')
	})

	it('keeps its height whatever the lists hold', async () => {
		const full = (await open('phases', 140, 45)).filter((row) => row.trim()).length
		await mounted?.unmount()
		const one = [member('solo', 'Only', 0)]
		mounted = await renderToScreen(
			<Box flexDirection="column" paddingX={1}>
				<AgentCockpit
					agents={one}
					selectedPhaseId={(one[0] as SubagentActivity).phaseId}
					selectedId="solo"
					focus="phases"
					terminalRows={45}
					terminalColumns={140}
				/>
			</Box>,
			{ cols: 140, rows: 45 },
		)
		expect(mounted.viewport().filter((row) => row.trim()).length).toBe(full)
		expect(workflowDetailPageSize(45)).toBe(14)
		expect(workflowDetailPageSize(30)).toBe(10)
		expect(workflowDetailPageSize(14)).toBe(4)
	})
})

// Reference (REA fns vt, Bo and Zt, chunk-t32eta2x.js): a list longer than the
// rows its pane holds says which of them it shows, in the box's bottom border.
describe('the window tag on the box border', () => {
	it('writes the arrows on the sides that have more, and a space on the side that has not', () => {
		const rows = (start: number, count: number) => ({
			start,
			items: Array.from({ length: count }),
		})
		expect(windowTag(rows(0, 8), 14)).toBe('  1–8 of 14 ↓')
		expect(windowTag(rows(3, 8), 14)).toBe('↑ 4–11 of 14 ↓')
		expect(windowTag(rows(6, 8), 14)).toBe('↑ 7–14 of 14  ')
	})

	it('shows on the agents pane only when the agents do not all fit', async () => {
		await mounted?.unmount()
		const many = Array.from({ length: 20 }, (_, index) => member(`m${index}`, 'Read', 0))
		mounted = await renderToScreen(
			<Box flexDirection="column" paddingX={1}>
				<AgentCockpit
					agents={many}
					selectedPhaseId={(many[0] as SubagentActivity).phaseId}
					selectedId="m0"
					focus="agents"
					terminalRows={45}
					terminalColumns={140}
				/>
			</Box>,
			{ cols: 140, rows: 45 },
		)
		const border = mounted.viewport().find((row) => row.includes('╰')) ?? ''
		expect(border).toMatch(/╰─+┴─+ {3}1–14 of 20 ↓ ╯/u)
		// The phases list has one phase: no tag on its side of the border.
		expect(border.split('┴')[0]).not.toContain('of')
		const few = (await open('agents', 140, 45)).find((row) => row.includes('╰')) ?? ''
		expect(few).not.toContain(' of ')
	})
})

describe('below 64 columns', () => {
	it('stacks one list at a time, frameless', async () => {
		const phases = (await open('phases', 50, 30)).join('\n')
		expect(phases).not.toContain('╭')
		expect(phases).toContain('Phases')
		expect(phases).toMatch(/❯ ✔\s+Read\s+2\/2/u)
		expect(phases).not.toContain('label a1')
		await mounted?.unmount()
		const list = (await open('agents', 50, 30)).join('\n')
		expect(list).toContain('Read · 2 agents')
		expect(list).toMatch(/❯ ✔\s+label a1/u)
		expect(list).toContain('↑↓ select · enter view')
	})

	it('is the stacked form at 63 and the box at 64 columns', async () => {
		expect((await open('phases', 63, 30)).join('\n')).not.toContain('╭')
		await mounted?.unmount()
		expect((await open('phases', 80, 30)).join('\n')).toContain('╭')
	})
})

describe('the launch tree', () => {
	const agent = (viewId: string, description: string) =>
		member(viewId, 'Work', 0, { description, background: true, status: 'working' })

	it('labels a launch with what the agent was asked to do', () => {
		expect(launchLabel(agent('a', 'Count words in a.txt'))).toBe('Count words in a.txt')
	})

	it('says N background agents launched, as a tree', () => {
		const receipt = launchReceipt([
			{ ...agent('a', 'Count words in a.txt'), workflow: 'Delegated work' },
			{ ...agent('b', 'List files'), workflow: 'Delegated work' },
		])
		expect(receipt.content).toBe(
			['2 background agents launched (↓ to manage)', '├ Count words in a.txt', '└ List files'].join(
				'\n',
			),
		)
	})
})

describe('the agent view', () => {
	it('draws the prompt and what the person sent as their own rows, bottom aligned', async () => {
		const { AgentView } = await import('../AgentExplorer.js')
		const viewed = member('v', 'Work', 0, {
			prompt: 'List the files',
			status: 'working',
			transcript: [
				{ id: 'a', kind: 'assistant', text: 'Looking now.' },
				{ id: 'm', kind: 'system', text: 'also count lines', direction: 'operator-to-child' },
			],
		})
		mounted = await renderToScreen(
			<Box flexDirection="column" paddingX={1}>
				<AgentView agent={viewed} tailOffset={0} pageRows={6} terminalColumns={60} />
			</Box>,
			{ cols: 62, rows: 8 },
		)
		const rows = mounted.viewport().filter((row) => row.trim())
		expect(rows.map((row) => row.trim())).toEqual([
			'❯ List the files',
			'● Looking now.',
			'❯ also count lines',
		])
		expect(
			mounted
				.viewport()
				.slice(-3)
				.some((row) => row.includes('also count lines')),
		).toBe(true)
	})
})
