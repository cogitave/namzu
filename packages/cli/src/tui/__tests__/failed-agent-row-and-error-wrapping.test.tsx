/**
 * A failed agent's row keeps its failure mark and its label however long the
 * error after it is, and the error text of a failed call is wrapped at word
 * boundaries and counted in the lines the text has.
 */

import { createRequire } from 'node:module'

import { Box } from 'ink'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
	type WorkflowAgentView,
	type WorkflowRunView,
	initialRunView,
} from '../../integrations/workflows/view.js'
import { AgentCockpit } from '../AgentExplorer.js'
import { Transcript } from '../Transcript.js'
import { wrapWords } from '../shell-cell.js'
import { theme } from '../theme.js'
import { type ToolEndEvent, toolEndRows } from '../tool-end-rows.js'
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

function failedCall(toolName: string, output: string): ToolEndEvent {
	return {
		kind: 'tool-end',
		toolUseId: 't1',
		toolName,
		isError: true,
		summary: output.split('\n')[0] ?? '',
		output,
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
		{ cols, rows: 80 },
	)
	screens.push(screen)
	await screen.waitForRender()
	return screen
}

const NOW = Date.now()

describe('a failed agent row in the workflow detail', () => {
	const error = `openai (HTTP 400) — ${'the provider rejected the request as invalid '.repeat(6)}END`
	const agent: WorkflowAgentView = {
		index: 1,
		label: 'child-bad-b: go',
		model: 'gpt-e2e-1',
		agentType: 'go',
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
	const run: WorkflowRunView = {
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

	for (const cols of [100, 60]) {
		it(`keeps the failure mark and the whole label at ${cols} columns`, async () => {
			const screen = await renderToScreen(
				<Box flexDirection="column" paddingX={1}>
					<AgentCockpit
						agents={withWorkflowRuns([], [run])}
						runs={[run]}
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
			console.log(screen.viewport().join('\n'))
			const row = screen.viewport().findIndex((line) => line.includes('child-bad-b: go'))
			expect(row).toBeGreaterThanOrEqual(0)
			const line = screen.row(row)
			expect(line).toMatch(/✘\s+child-bad-b: go/)
			expect(screen.cell(row, line.indexOf('✘')).fg).toBe(ERROR_FG)
		})
	}
})

describe('the body of a failed call', () => {
	const words = (count: number) => Array.from({ length: count }, (_, i) => `word${i + 1}`).join(' ')

	it('breaks only at spaces, and cuts a word longer than the whole width', () => {
		expect(wrapWords('alpha beta gamma delta', 11)).toEqual(['alpha beta', 'gamma delta'])
		expect(wrapWords('  indented words here', 12)).toEqual(['  indented', 'words here'])
		const rows = wrapWords(`ab ${'x'.repeat(25)} cd`, 10)
		expect(rows.every((row) => row.length <= 10)).toBe(true)
		expect(rows.join('').replace(/ /g, '')).toBe(`ab${'x'.repeat(25)}cd`)
		expect(rows[0]).toBe('ab')
	})

	for (const cols of [100, 60]) {
		it(`never breaks a word, at ${cols} columns`, async () => {
			const text = `${'general-purpose agent could not reach the provider '.repeat(4)}`
			const screen = await draw(rowsOf(failedCall('agent', text)), cols)
			const shown = screen.scrollback().join('\n')
			expect(shown).toContain('general-purpose')
			expect(shown).toContain('provider')
			const allowed = new Set([
				...text.split(/\s+/),
				'⎿',
				'●',
				'agent(x)',
				'●agent(x)',
				'Error:',
				'',
			])
			for (const piece of shown.split(/\s+/)) expect(allowed).toContain(piece)
		})

		it(`counts the cap in the lines of the text, at ${cols} columns`, async () => {
			const long = Array.from({ length: 18 }, (_, i) => `line${i + 1} ${words(30)}`).join('\n')
			const screen = await draw(rowsOf(failedCall('agent', long)), cols)
			const shown = screen.scrollback().join('\n')
			expect(shown).toContain('line10 ')
			expect(shown).not.toContain('line11 ')
			expect(shown).toContain('… +8 lines (ctrl+o to expand)')
			const open = (await draw(rowsOf(failedCall('agent', long)), cols, true))
				.scrollback()
				.join('\n')
			expect(open).toContain('line18 ')
			expect(open).not.toContain('ctrl+o to expand')
		})
	}

	it('wraps the first line of a script that could not start at word boundaries', async () => {
		const first = `cannot ${'continue because the script is not valid '.repeat(3)}done`
		const shown = (await draw(rowsOf(failedCall('workflow', `${first}\nsecond`)), 60))
			.scrollback()
			.join('\n')
		expect(shown).toContain('✘ cannot')
		expect(shown).not.toContain('second')
		expect(shown).not.toMatch(/\bcan\n|\bnot\w/)
	})
})
