/**
 * A failed agent and a workflow script that could not start show the error
 * text the agent or the tool produced, in the error colour: no plain
 * sentence in its place. A failed agent call folds after ten lines; an
 * agent's own view shows the whole message under an `Error` heading; a
 * script that could not start shows the first line of its error.
 */

import { createRequire } from 'node:module'

import { Box } from 'ink'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
	type SubagentActivity,
	SubagentActivityMonitor,
} from '../../integrations/subagents/activity.js'
import {
	type WorkflowAgentView,
	type WorkflowRunView,
	initialRunView,
} from '../../integrations/workflows/view.js'
import { AgentCockpit, AgentView } from '../AgentExplorer.js'
import { Transcript } from '../Transcript.js'
import { theme } from '../theme.js'
import { type ToolEndEvent, toolEndRows } from '../tool-end-rows.js'
import { toolFailureText } from '../tool-failure-text.js'
import type { TranscriptMessage } from '../types.js'
import { withWorkflowRuns } from '../workflow-runs.js'
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

/** The emulator's name for the theme's error colour. */
const ERROR_FG = `palette:${/\((\d+)\)/.exec(theme.status.error)?.[1]}`

const screens: Screen[] = []
afterEach(async () => {
	for (const screen of screens.splice(0)) await screen.unmount()
})

function failedCall(toolName: string, output: string | undefined): ToolEndEvent {
	return {
		kind: 'tool-end',
		toolUseId: 't1',
		toolName,
		isError: true,
		summary: (output ?? '').split('\n')[0] ?? '',
		...(output !== undefined ? { output } : {}),
	} as ToolEndEvent
}

function rowsOf(event: ToolEndEvent): TranscriptMessage[] {
	const built = toolEndRows(event, { label: `${event.toolName}(x)` }, { hasPlan: false })
	if (built.kind !== 'rows') throw new Error('expected rows')
	return built.rows.map((row, i) => ({ id: `r${i}`, detailRef: i + 1, ...row }))
}

async function draw(messages: TranscriptMessage[], cols: number, expanded = false) {
	const shown = expanded ? messages.map((m) => ({ ...m, detailExpanded: true })) : messages
	const screen = await renderToScreen(
		<Transcript messages={shown} pending={null} state="idle" settled={0} resetKey={0} />,
		{ cols, rows: 60 },
	)
	screens.push(screen)
	await screen.waitForRender()
	return screen
}

const lines = (count: number) => Array.from({ length: count }, (_, i) => `detail ${i + 1}`)

describe('the text of a failed tool call', () => {
	it('keeps a leading "Error: " or "Cancelled: " and adds "Error: " to anything else', () => {
		expect(toolFailureText('Error: boom', false)).toBe('Error: boom')
		expect(toolFailureText('Cancelled: by the person', false)).toBe('Cancelled: by the person')
		expect(toolFailureText('boom', false)).toBe('Error: boom')
	})

	it('unwraps the tool error wrapper and drops error tags and sandbox blocks', () => {
		expect(toolFailureText('<tool_use_error>nope</tool_use_error>', false)).toBe('Error: nope')
		expect(
			toolFailureText('a <error>b</error>\n<sandbox_violations>x\ny</sandbox_violations>', false),
		).toBe('Error: a b')
	})

	it('says "Tool execution failed" when the call has no text', () => {
		expect(toolFailureText(undefined, false)).toBe('Tool execution failed')
	})

	it('folds an input validation error to a short phrase until it is expanded', () => {
		const text = 'InputValidationError: missing "prompt"'
		expect(toolFailureText(text, false)).toBe('Invalid tool parameters')
		expect(toolFailureText(text, true)).toBe(`Error: ${text}`)
	})
})

describe('a failed agent call in the conversation', () => {
	const raw = `openai (HTTP 400) — the provider rejected the request as invalid: {"error":"bad"}`

	for (const cols of [100, 60]) {
		it(`shows the raw error under the call in the error colour at ${cols} columns`, async () => {
			const screen = await draw(rowsOf(failedCall('agent', raw)), cols)
			const text = screen.scrollback().join('\n')
			expect(text).toContain('Error: openai (HTTP 400)')
			expect(text).not.toMatch(/provider could not use this request|something went wrong/)
			const row = screen.viewport().findIndex((line) => line.includes('Error: openai'))
			const col = screen.row(row).indexOf('Error:')
			expect(screen.cell(row, col).fg).toBe(
				screen.cell(
					screen.viewport().findIndex((line) => line.includes('● agent(x)')),
					0,
				).fg,
			)
		})
	}

	it('shows ten lines and then how many more ctrl+o shows', async () => {
		const text = (await draw(rowsOf(failedCall('agent', lines(25).join('\n'))), 100))
			.scrollback()
			.join('\n')
		// "Error: " joins the first line.
		expect(text).toContain('Error: detail 1')
		expect(text).toContain('detail 10')
		expect(text).not.toContain('detail 11')
		expect(text).toContain('… +15 lines (ctrl+o to expand)')
	})

	it('says "line" for exactly one folded line, and no hint for exactly ten', async () => {
		const eleven = (await draw(rowsOf(failedCall('agent', lines(11).join('\n'))), 100))
			.scrollback()
			.join('\n')
		expect(eleven).toContain('… +1 line (ctrl+o to expand)')
		expect(eleven).not.toContain('detail 11')
		const ten = (await draw(rowsOf(failedCall('agent', lines(10).join('\n'))), 100))
			.scrollback()
			.join('\n')
		expect(ten).toContain('detail 10')
		expect(ten).not.toContain('ctrl+o to expand')
	})

	it('shows every line and no hint when expanded', async () => {
		const text = (await draw(rowsOf(failedCall('agent', lines(25).join('\n'))), 100, true))
			.scrollback()
			.join('\n')
		expect(text).toContain('detail 25')
		expect(text).not.toContain('ctrl+o to expand')
	})

	it('counts a long line as one line', async () => {
		const text = (await draw(rowsOf(failedCall('agent', `${'long '.repeat(80)}\nsecond`)), 60))
			.scrollback()
			.join('\n')
		expect(text).toContain('second')
		expect(text).not.toContain('ctrl+o to expand')
	})

	it('says "Tool execution failed" when the call produced no text', async () => {
		const text = (await draw(rowsOf(failedCall('agent', undefined)), 100)).scrollback().join('\n')
		expect(text).toContain('Tool execution failed')
	})

	it('shows an input validation error short, and whole when expanded', async () => {
		const event = failedCall('agent', 'InputValidationError: missing "prompt"')
		expect((await draw(rowsOf(event), 100)).scrollback().join('\n')).toContain(
			'Invalid tool parameters',
		)
		expect((await draw(rowsOf(event), 100, true)).scrollback().join('\n')).toContain(
			'Error: InputValidationError: missing "prompt"',
		)
	})
})

describe('a workflow script that could not start', () => {
	const output = [
		"The script stopped at line 3, column 20: cannot read property 'length' of undefined",
		'That line reads: const x = args.nope.length',
		'No agent had started.',
	].join('\n')

	for (const cols of [100, 60]) {
		it(`shows the failure mark and only the first line of the error at ${cols} columns`, async () => {
			const screen = await draw(rowsOf(failedCall('workflow', output)), cols)
			const text = screen.scrollback().join('\n')
			expect(text).toContain('✘ The script stopped at line 3')
			expect(text).not.toContain('That line reads')
			expect(text).not.toContain('ctrl+o')
			expect(text).not.toContain('The workflow script stopped with an error.')
			const row = screen.viewport().findIndex((line) => line.includes('✘ The script'))
			expect(screen.cell(row, screen.row(row).indexOf('✘')).fg).toBe(ERROR_FG)
		})
	}

	it('keeps the error name the script printed', () => {
		const rows = rowsOf(failedCall('workflow', 'TypeError: boom\nmore'))
		expect(rows[0]?.shell?.stderr).toEqual(['✘ TypeError: boom'])
	})
})

describe('a failed agent in its own view', () => {
	function failedAgent(error: string): SubagentActivity {
		const monitor = new SubagentActivityMonitor()
		const tracker = monitor.begin({ agentId: 'general-purpose', description: 'Audit', prompt: 'p' })
		tracker.fail(new Error(error))
		const [agent] = monitor.getSnapshot()
		if (!agent) throw new Error('no agent')
		return agent
	}

	it('keeps the agent error verbatim on the row and on the agent', () => {
		const raw = 'openai (HTTP 400) — the provider rejected the request as invalid: {"e":1}'
		const agent = failedAgent(raw)
		expect(agent.error).toBe(raw)
		expect(agent.transcript.at(-1)).toMatchObject({ kind: 'system', text: raw, failure: true })
	})

	for (const cols of [100, 60]) {
		it(`draws an Error heading and the whole message in the error colour at ${cols} columns`, async () => {
			const raw = `openai (HTTP 400) — ${'the provider rejected the request as invalid '.repeat(4)}END`
			const screen = await renderToScreen(
				<AgentView agent={failedAgent(raw)} tailOffset={0} pageRows={20} terminalColumns={cols} />,
				{ cols, rows: 24 },
			)
			screens.push(screen)
			const text = screen.viewport().join('\n')
			expect(text).toMatch(/\n\s*Error\n/)
			expect(text.replace(/\s+/g, ' ')).toContain('openai (HTTP 400)')
			expect(text.replace(/\s+/g, ' ')).toContain('END')
			expect(text).not.toMatch(/stopped because something went wrong/)
			const heading = screen.viewport().findIndex((line) => line.trim() === 'Error')
			const cell = screen.cell(heading, screen.row(heading).indexOf('Error'))
			expect(cell.bold).toBe(true)
			const body = screen.viewport().findIndex((line) => line.includes('openai'))
			expect(cell.fg).toBe(ERROR_FG)
			expect(screen.cell(body, screen.row(body).indexOf('openai')).fg).toBe(ERROR_FG)
		})
	}
})

describe('a failed agent in a workflow', () => {
	const NOW = Date.now()
	function run(error: string): WorkflowRunView {
		const agent: WorkflowAgentView = {
			index: 1,
			label: 'scan',
			phaseIndex: 1,
			phaseTitle: 'Scan',
			queuedAt: NOW - 20_000,
			startedAt: NOW - 15_000,
			finishedAt: NOW - 5_000,
			tokens: 0,
			toolCalls: 0,
			status: 'failed',
			error,
		}
		return {
			...initialRunView({
				runId: 'wrun1',
				name: 'audit',
				description: 'd',
				phases: [{ title: 'Scan' }],
				at: NOW - 20_000,
			}),
			status: 'failed',
			endedAt: NOW - 5_000,
			agents: [agent],
		}
	}

	for (const cols of [100, 60]) {
		it(`adds the agent's raw error after its row, in the error colour, at ${cols} columns`, async () => {
			const r = run('rate limited by the provider')
			const screen = await renderToScreen(
				<Box flexDirection="column" paddingX={1}>
					<AgentCockpit
						agents={withWorkflowRuns([], [r])}
						runs={[r]}
						selectedPhaseId="wfrun:wrun1:p:1"
						selectedId=""
						focus="agents"
						terminalRows={30}
						terminalColumns={cols}
					/>
				</Box>,
				{ cols, rows: 30 },
			)
			screens.push(screen)
			const text = screen.viewport().join('\n')
			expect(text).toMatch(/scan.* — rate limited/)
			const row = screen.viewport().findIndex((line) => line.includes(' — rate limited'))
			const col = screen.row(row).indexOf('— rate')
			expect(screen.cell(row, col).fg).toBe(ERROR_FG)
		})
	}
})
