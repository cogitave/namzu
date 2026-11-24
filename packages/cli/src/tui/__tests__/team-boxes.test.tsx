/**
 * Boxes in the team's transcripts and the rail's remaining rules, on a real screen: a bordered box row
 * in the conversation (and plain under 40 columns, and uncoloured under NO_COLOR), the boxes a teammate
 * reads in its own transcript, the folded idle row as a stop of the rail, and the up and down markers.
 */

import { createRequire } from 'node:module'

import { Box } from 'ink'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import type { TeamMemberView } from '../../integrations/teams/view.js'
import {
	AgentTaskPanel,
	AgentView,
	agentTranscriptRows,
	railAgents,
	teamRailOf,
} from '../AgentExplorer.js'
import { Transcript } from '../Transcript.js'
import { boxRow, planRequestBox, shutdownRefusedBox } from '../team-rows.js'
import {
	TEAM_IDLE_FOLD_FOCUS,
	TEAM_STOP_ALL_COLUMNS,
	teamRailHint,
	teamRailPlan,
	teamViewEscHint,
	teammateWaiting,
} from '../team-view.js'
import { theme } from '../theme.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as { level: number }
const originalLevel = chalk.level
beforeAll(() => {
	chalk.level = 3
})
afterAll(() => {
	chalk.level = originalLevel
})

const NOW = 1_000_000
const paletteOf = (color: string) => `palette:${/\((\d+)\)/.exec(color)?.[1]}`

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
	process.env.NO_COLOR = undefined
	Reflect.deleteProperty(process.env, 'NO_COLOR')
})

async function drawRow(row: ReturnType<typeof boxRow>, cols: number): Promise<Screen> {
	const message: TranscriptMessage = { id: 'm1', ...row }
	mounted = await renderToScreen(
		<Transcript messages={[message]} pending={null} state="idle" settled={0} resetKey={0} />,
		{ cols, rows: 30 },
	)
	await mounted.waitForRender()
	return mounted
}

describe('a box row in the conversation', () => {
	const refused = boxRow(shutdownRefusedBox('one', 'still writing the tests'))

	it('draws a rounded border with the title, reason and dim footnote inside it', async () => {
		const screen = await drawRow(refused, 80)
		const lines = screen.scrollback().filter((line) => line.trim() !== '')
		expect(lines[0]).toMatch(/^╭─+╮$/u)
		expect(lines.at(-1)).toMatch(/^╰─+╯$/u)
		expect(lines.join('\n')).toContain('│ Shutdown refused by @one')
		expect(lines.join('\n')).toContain('Reason: still writing the tests')
		expect(lines.join('\n')).toContain('Still working. Ask again later.')
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(80)
	})

	it('wraps a long plan inside the border at 60 columns', async () => {
		const plan = planRequestBox(
			'one',
			`1. ${'read the whole module and note every caller '.repeat(4)}`,
		)
		const screen = await drawRow(boxRow(plan), 60)
		const lines = screen.scrollback().filter((line) => line.trim() !== '')
		expect(lines.length).toBeGreaterThan(5)
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(60)
		for (const line of lines.slice(1, -1)) expect(line).toMatch(/^│ .* │$/u)
	})

	it('is a plain indented block under 40 columns', async () => {
		const screen = await drawRow(refused, 36)
		const text = screen.scrollback().join('\n')
		expect(text).not.toMatch(/[╭╮╰╯│]/u)
		expect(text).toContain('Shutdown refused by @one')
		expect(text).toMatch(/^ {2}Reason: /mu)
		for (const line of screen.scrollback()) expect(line.length).toBeLessThanOrEqual(36)
	})

	it('colours the border in the tone, and leaves it uncoloured under NO_COLOR', async () => {
		const warn = boxRow({
			tone: 'theme:status.warn',
			title: [{ text: 'Waiting' }],
		})
		const screen = await drawRow(warn, 60)
		const top = screen.viewport().findIndex((line) => line.startsWith('╭'))
		expect(screen.cell(top, 0).fg).toBe(paletteOf(theme.status.warn))
		await screen.unmount()
		mounted = undefined
		process.env.NO_COLOR = '1'
		const plain = await drawRow(warn, 60)
		const row = plain.viewport().findIndex((line) => line.startsWith('╭'))
		expect(plain.row(row)).toMatch(/^╭─+╮$/u)
		// The border takes the row's own colour, not the tone's.
		expect(plain.cell(row, 0).fg).not.toBe(paletteOf(theme.status.warn))
		expect(plain.cell(row, 0).fg).toBe(paletteOf(theme.text.primary))
	})
})

describe("the boxes in a teammate's own transcript", () => {
	function teammateAgent(transcript: SubagentActivity['transcript']): SubagentActivity {
		return {
			viewId: 'v-one',
			agentId: 'teammate-type',
			description: 'one works',
			prompt: 'SYSTEM',
			batchId: 'b',
			workflowId: 'w',
			workflowGroupId: 'g',
			phaseId: 'p',
			workflow: 'Delegated work',
			phase: 'Work',
			phaseSequence: 0,
			status: 'working',
			background: true,
			startedAt: 1,
			transcript,
		}
	}
	const task: SubagentActivity['transcript'][number] = {
		id: 'a',
		kind: 'system',
		text: 'framed',
		direction: 'to-child',
		mail: { kind: 'task', from: 'lead', body: 'Write part two' },
	}
	const stop: SubagentActivity['transcript'][number] = {
		id: 'b',
		kind: 'system',
		text: 'framed',
		direction: 'to-child',
		mail: { kind: 'stop', from: 'lead', body: 'wrapping up' },
	}

	it('shows a task given as a box with its number, giver and subject', () => {
		const rows = agentTranscriptRows(teammateAgent([task]), 100, {
			name: 'one',
			taskNumberOf: (subject) => (subject === 'Write part two' ? 2 : undefined),
		})
		const text = rows.map((row) => row.text)
		expect(text[0]).toMatch(/^╭─+╮$/u)
		expect(text.join('\n')).toContain('Task #2 assigned by lead')
		expect(text.join('\n')).toContain('Write part two')
		expect(rows.every((row) => row.spans !== undefined)).toBe(true)
	})

	it('shows a request to stop as a warning box with the reason', () => {
		const rows = agentTranscriptRows(teammateAgent([stop]), 100, { name: 'one' })
		const text = rows.map((row) => row.text).join('\n')
		expect(text).toContain('Shutdown request from lead')
		expect(text).toContain('Reason: wrapping up')
		expect(rows[1]?.spans?.[0]?.tone).toBe('theme:status.warn')
	})

	it('adds a box at the end while its call waits on the lead, with the tool and the action', () => {
		const rows = agentTranscriptRows(
			teammateAgent([{ id: 'x', kind: 'assistant', text: 'on it' }]),
			100,
			{
				name: 'one',
				waiting: { kind: 'ask', tool: 'bash', action: 'touch a.txt' },
			},
		)
		const text = rows.map((row) => row.text).join('\n')
		expect(text).toContain('Waiting for team lead approval')
		expect(text).toMatch(/Tool\s+bash/u)
		expect(text).toMatch(/Action\s+touch a\.txt/u)
		expect(text).toContain('The request was sent to the team lead.')
		expect(rows.at(-1)?.text).toMatch(/^╰─+╯$/u)
	})

	it('says the plan was submitted once it is sent', () => {
		const rows = agentTranscriptRows(
			teammateAgent([{ id: 'x', kind: 'assistant', text: 'on it' }]),
			100,
			{
				name: 'one',
				waiting: { kind: 'plan' },
			},
		)
		const text = rows.map((row) => row.text).join('\n')
		expect(text).toContain('Plan submitted for team lead approval')
		expect(text).toContain('Waiting for team lead approval…')
	})

	it('draws the boxes on a real screen without a row wider than it', async () => {
		const agent = teammateAgent([task, stop, { id: 'x', kind: 'assistant', text: 'on it' }])
		for (const cols of [100, 60]) {
			mounted = await renderToScreen(
				<AgentView
					agent={agent}
					tailOffset={0}
					pageRows={30}
					terminalColumns={cols}
					teammate={{
						name: 'one',
						hint: teamViewEscHint('working'),
						waiting: { kind: 'ask', tool: 'bash', action: 'touch a.txt' },
					}}
				/>,
				{ cols, rows: 32 },
			)
			await mounted.waitForRender()
			const lines = mounted.viewport().filter((line) => line.trim() !== '')
			const text = lines.join('\n')
			expect(text).toContain('Task assigned by lead')
			expect(text).toContain('Shutdown request from lead')
			expect(text).toContain('Waiting for team lead approval')
			expect(lines.at(-1)).toContain('esc to interrupt')
			for (const line of lines) expect(line.length).toBeLessThanOrEqual(cols)
			await mounted.unmount()
			mounted = undefined
		}
	})
})

describe('what Esc says in an opened teammate', () => {
	it('interrupts a working teammate and returns from an idle or waiting one', () => {
		expect(teamViewEscHint('working')).toBe('esc to interrupt')
		expect(teamViewEscHint('idle')).toBe('esc to return to team lead')
		expect(teamViewEscHint('waiting')).toBe('esc to return to team lead')
		expect(teamViewEscHint('stopped')).toBe('esc to return to team lead')
		expect(teamViewEscHint(undefined)).toBe('esc to return to team lead')
	})

	it('reads what a waiting teammate waits for from its member row', () => {
		const base: TeamMemberView = {
			name: 'one',
			viewId: 'v',
			state: 'waiting',
			color: 'red',
			since: 0,
		}
		expect(teammateWaiting({ ...base, ask: { tool: 'bash', action: 'ls' } })).toEqual({
			waiting: { kind: 'ask', tool: 'bash', action: 'ls' },
		})
		expect(teammateWaiting({ ...base, awaitingPlan: true })).toEqual({ waiting: { kind: 'plan' } })
		expect(teammateWaiting({ ...base, state: 'working', ask: { tool: 'bash' } })).toEqual({})
		expect(teammateWaiting(undefined)).toEqual({})
	})
})

describe('the rail', () => {
	const idle = (name: string): TeamMemberView => ({
		name,
		viewId: `v-${name}`,
		state: 'idle',
		color: 'blue',
		since: NOW - 2_000,
	})
	const act = (viewId: string): SubagentActivity => ({
		viewId,
		agentId: 'teammate-type',
		description: viewId,
		prompt: 'p',
		batchId: 'b',
		workflowId: 'w',
		workflowGroupId: 'g',
		phaseId: 'p',
		workflow: 'Delegated work',
		phase: 'Work',
		phaseSequence: 0,
		status: 'completed',
		background: true,
		startedAt: NOW - 60_000,
		completedAt: NOW - 20_000,
		transcript: [],
	})

	async function show(
		members: readonly TeamMemberView[],
		options: { expand?: boolean; selectedIndex?: number; cols?: number } = {},
	) {
		const agents = members.map((m) => act(m.viewId))
		const team = teamRailOf({ members, tasks: [] }, agents, NOW, options.expand === true)
		const listed = railAgents(agents, NOW, new Set(), null, team)
		mounted = await renderToScreen(
			<Box flexDirection="column" paddingRight={1}>
				<AgentTaskPanel
					agents={listed}
					{...(team ? { team } : {})}
					terminalRows={40}
					terminalColumns={options.cols ?? 100}
					now={NOW}
					{...(options.selectedIndex !== undefined ? { selectedIndex: options.selectedIndex } : {})}
				/>
			</Box>,
			{ cols: options.cols ?? 100, rows: 20 },
		)
		return mounted.viewport().filter((row) => row.trim() !== '')
	}

	const four = ['a', 'b', 'c', 'd'].map(idle)

	it('folds more than three idle teammates, and opens them when the person expands the row', () => {
		expect(teamRailPlan(four, NOW).folded).toBe(4)
		const opened = teamRailPlan(four, NOW, false, true)
		expect(opened.folded).toBe(0)
		expect(opened.shown.size).toBe(4)
	})

	it('still lets idle rows go once the whole rail has been idle, folded or opened', () => {
		const old = four.map((m) => ({ ...m, since: NOW - 30_000 }))
		expect(teamRailPlan(old, NOW, false, true).shown.size).toBe(0)
		expect(teamRailPlan(old, NOW).folded).toBe(0)
		// One working teammate keeps the rail awake: the idle ones stay.
		const awake = [...old, { ...idle('w'), state: 'working' as const, since: 0 }]
		expect(teamRailPlan(awake, NOW).folded).toBe(4)
	})

	it('makes the folded row a stop of the rail: the marker lands on it', async () => {
		// main, then no agent rows (all folded), so the folded row is index 1.
		const rows = await show(four, { selectedIndex: 1 })
		expect(rows.some((row) => row.includes('❯') && row.includes('4 idle agents'))).toBe(true)
		expect(TEAM_IDLE_FOLD_FOCUS).toBe('team:idle')
	})

	it('lists every idle teammate once the folded row is opened', async () => {
		const rows = await show(four, { expand: true })
		const text = rows.join('\n')
		expect(text).not.toContain('idle agents')
		for (const name of ['a', 'b', 'c', 'd']) expect(text).toMatch(new RegExp(`◯ ${name}\\s`, 'u'))
	})

	it('shows up and down markers when more than five rows are listed', async () => {
		const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => ({
			...idle(n),
			state: 'working' as const,
			since: 0,
		}))
		const top = (await show(seven, { selectedIndex: 1 })).join('\n')
		expect(top).toContain('↓ 2 more')
		expect(top).not.toContain('↑')
		const bottom = (await show(seven, { selectedIndex: 7 })).join('\n')
		expect(bottom).toContain('↑ 2 more')
		expect(bottom).not.toContain('↓ 2 more')
	})
})

describe('the stop-all hint on a teammate row', () => {
	it('is named only with more than one agent running and 90 columns or more', () => {
		const chord = 'ctrl+x ctrl+k to stop all agents'
		expect(
			teamRailHint('working', 'one', false, false, { running: 2, columns: TEAM_STOP_ALL_COLUMNS }),
		).toContain(chord)
		expect(teamRailHint('working', 'one', false, false, { running: 2, columns: 89 })).not.toContain(
			'ctrl+x',
		)
		expect(
			teamRailHint('working', 'one', false, false, { running: 1, columns: 120 }),
		).not.toContain('ctrl+x')
		expect(teamRailHint('working', 'one', false, false)).not.toContain('ctrl+x')
		expect(TEAM_STOP_ALL_COLUMNS).toBe(90)
	})
})
