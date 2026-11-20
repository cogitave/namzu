/**
 * The task rows under the status line, where the pointer is reported (the full screen view): each
 * row is a click region that opens what Enter on it would, and is drawn bright while the pointer is
 * on it. A row is `❯ ` (only on the row the keys are on), then the glyph, then the name; the key
 * line is `↑↓ select · enter view · x stop`. Driven by pointer reports on an emulated screen.
 */

import { Box } from 'ink'
import { afterEach, expect, it, vi } from 'vitest'

// Colour on, so a bright row can be told from a dim one.
vi.hoisted(() => {
	process.env.FORCE_COLOR = '3'
})

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import { AgentTaskPanel, type RailWorkflow, railHint } from '../AgentExplorer.js'
import type { PointerReport } from '../fullscreen/mouse-wheel.js'
import { PointerRegionsContext } from '../pointer/context.js'
import { createPointerRegions } from '../pointer/regions.js'
import { type Screen, renderToScreen } from './support/screen.js'

const NOW = 100_000
let mounted: Screen | null = null
afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

const workflow: RailWorkflow = {
	id: 'wf-1',
	focusId: 'workflow:wf-1',
	name: 'Release audit',
	startedAt: NOW - 134_000,
	status: 'working',
	done: 3,
	total: 7,
	failed: 0,
	large: false,
	hypermode: false,
	runningPhases: [],
	agents: [],
} as unknown as RailWorkflow

const worker = (viewId: string): SubagentActivity =>
	({
		viewId,
		agentId: 'explorer',
		description: `Job ${viewId}`,
		prompt: 'p',
		batchId: 'b',
		workflowId: 't',
		workflowGroupId: 'g',
		phaseId: 'p1',
		workflow: 'Delegated work',
		phase: 'Work',
		phaseSequence: 0,
		status: 'working',
		startedAt: NOW - 12_000,
		transcript: [],
	}) as SubagentActivity

async function mount(selectedIndex?: number, clickable = true) {
	const regions = createPointerRegions()
	const opened: string[] = []
	const screen = await renderToScreen(
		<PointerRegionsContext.Provider value={regions}>
			<Box flexDirection="column" paddingRight={1}>
				<AgentTaskPanel
					agents={[worker('a'), worker('b')]}
					workflows={[workflow]}
					terminalRows={40}
					terminalColumns={100}
					now={NOW}
					{...(clickable ? { onActivateRow: (id: string) => opened.push(id) } : {})}
					{...(selectedIndex !== undefined ? { selectedIndex } : {})}
				/>
			</Box>
		</PointerRegionsContext.Provider>,
		{ cols: 100, rows: 12, alternateScreen: true, incrementalRendering: true },
	)
	mounted = screen
	await screen.waitForRender()
	const row = (text: string) => {
		const y = screen.viewport().findIndex((line) => line.includes(text))
		return { x: (screen.viewport()[y] ?? '').indexOf(text) + 1, y: y + 1 }
	}
	const send = async (report: PointerReport) => {
		const before = screen.writes().length
		regions.handle(report)
		await screen.waitForRender()
		return screen.writes().slice(before).join('')
	}
	const click = async (x: number, y: number) => {
		await send({ kind: 'press', x, y })
		await send({ kind: 'release', x, y })
	}
	return { screen, regions, opened, row, send, click }
}

it('draws the pointer column and the glyph in front of every row, the pointer only on the selected one', async () => {
	const m = await mount(3)
	const lines = m.screen.viewport().filter((line) => line.trim().length > 0)
	expect(lines[0]).toMatch(/^ {2}● main/u)
	expect(lines[1]).toMatch(/^ {2}◯ explorer/u)
	expect(lines.at(-1)).toMatch(/^❯ ◯ Release audit +▰+▱+ +3\/7 · 2m14s/u)
})

it('opens a row on a click, by the id Enter would use', async () => {
	const m = await mount()
	await m.click(m.row('Release audit').x + 2, m.row('Release audit').y)
	await m.click(m.row('Job b').x + 1, m.row('Job b').y)
	await m.click(m.row('main').x, m.row('main').y)
	expect(m.opened).toEqual(['workflow:wf-1', 'b', 'main'])
})

it('registers no click region on any row when no row handler is given (a permission dialog is up)', async () => {
	const m = await mount(undefined, false)
	await m.click(m.row('main').x, m.row('main').y)
	await m.click(m.row('Release audit').x + 2, m.row('Release audit').y)
	expect(m.opened).toEqual([])
	expect(m.regions.handle({ kind: 'press', x: m.row('main').x, y: m.row('main').y })).toBe(false)
})

it('does nothing for a click that lands between the rows', async () => {
	const m = await mount()
	await m.click(3, 1)
	expect(m.opened).toEqual([])
})

it('draws the row under the pointer bright, once, and puts it out when the pointer leaves', async () => {
	const m = await mount()
	const flow = m.row('Release audit')
	const first = await m.send({ kind: 'move', x: flow.x + 1, y: flow.y })
	expect(first).not.toBe('')
	expect(await m.send({ kind: 'move', x: flow.x + 4, y: flow.y })).toBe('')
	expect(await m.send({ kind: 'move', x: 1, y: 12 })).not.toBe('')
})

it('says what the keys do in the reference order', () => {
	expect(railHint(worker('a'), 140)).toBe('↑↓ select · enter view · x stop')
	expect(railHint({ ...worker('a'), status: 'completed' }, 140)).toBe(
		'↑↓ select · enter view · x clear',
	)
	expect(railHint(undefined, 140)).toBe('↑↓ select · enter view')
})
