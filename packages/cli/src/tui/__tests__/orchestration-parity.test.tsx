/**
 * The delegated-work surfaces aligned with the reference terminal: the
 * phased cockpit, the rows delegated work leaves in the conversation,
 * the folded waiting line, the effort slider and the hypermode rule on the
 * message box. Each is checked at a comfortable width, at 40 columns, and
 * with Turkish text, whose dotted/dotless i and cedilla letters are the
 * cheapest way to catch a width or case-folding assumption.
 */

import { createRequire } from 'node:module'

import { Box } from 'ink'
import stringWidth from 'string-width'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import { AgentCockpit } from '../AgentExplorer.js'
import { ComposerFrame } from '../ComposerFrame.js'
import { EffortSlider, effortSliderLayout } from '../EffortSlider.js'
import { LiveActivity, waitingLine } from '../LiveActivity.js'
import { StatusBar } from '../StatusBar.js'
import { metaSeparator } from '../Transcript.js'
import {
	agentDoneRows,
	agentMessageRow,
	agentNotice,
	childMessageNotice,
	childMessageRow,
	failureReason,
	launchReceipt,
	reportsAsNotification,
	settleLine,
} from '../agent-transcript-rows.js'
import { type Screen, renderToScreen } from './support/screen.js'

// The test terminal is a colour TTY; the Vitest process itself usually is not.
// Colour is turned on on Ink's own Chalk instance for the two colour checks.
const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as { level: number }
const originalColorLevel = chalk.level
beforeAll(() => {
	chalk.level = 3
})
afterAll(() => {
	chalk.level = originalColorLevel
})

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
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
		startedAt: 1_000,
		transcript: [],
		...input,
	}
}

describe('launch receipt', () => {
	it('names every unlabelled agent of one batch under one line, in start order', () => {
		const receipt = launchReceipt([
			agent({ viewId: 'b', description: 'İkinci rengi seç', startedAt: 2_000 }),
			agent({ viewId: 'a', description: 'Birinci rengi seç', startedAt: 1_000 }),
		])
		expect(receipt.content.split('\n')).toEqual([
			'Launched 2 agents',
			'├ Birinci rengi seç',
			'└ İkinci rengi seç',
		])
	})

	it('gives a labelled workflow one group line instead of its agents', () => {
		const receipt = launchReceipt([
			agent({ viewId: 'b', startedAt: 2_000, workflow: 'İki aşamalı cümle', phase: 'Aşama 1' }),
			agent({ viewId: 'a', startedAt: 1_000, workflow: 'İki aşamalı cümle', phase: 'Aşama 1' }),
		])
		expect(receipt.content.split('\n')).toEqual([
			'Workflow İki aşamalı cümle',
			'⎿ Running in background · ↓ to manage',
		])
	})

	it('names one agent inline, and leaves the unlabelled defaults out', () => {
		expect(
			launchReceipt([agent({ viewId: 'solo', description: 'Join the colours' })]).content,
		).toBe('Launched Join the colours')
	})

	it('offers the manage key only when every agent of the batch runs in the background', () => {
		expect(
			launchReceipt([
				agent({ viewId: 'a', description: 'One', background: true }),
				agent({ viewId: 'b', description: 'Two', background: true }),
			]).content.split('\n')[0],
		).toBe('2 background agents launched (↓ to manage)')
		expect(
			launchReceipt([
				agent({ viewId: 'a', description: 'One', background: true }),
				agent({ viewId: 'b', description: 'Two' }),
			]).content.split('\n')[0],
		).toBe('Launched 2 agents')
		expect(
			launchReceipt([agent({ viewId: 'solo', description: 'Alone', background: true })]).content,
		).toBe('Launched Alone (↓ to manage)')
	})

	it('never carries a line break or tab a model put in a label', () => {
		const receipt = launchReceipt([
			agent({ viewId: 'x', description: 'one\ntwo\tthree' }),
			agent({ viewId: 'y', description: 'four' }),
		])
		expect(receipt.content.split('\n')).toHaveLength(3)
		expect(receipt.content).toContain('├ one two three')
	})
})

describe('what a finished agent leaves in the conversation', () => {
	it('joins a parenthesised hint with a space and any other hint with a middle dot', () => {
		expect(metaSeparator('(ctrl+o to expand)')).toBe(' ')
		expect(metaSeparator('correction sent')).toBe(' · ')
	})

	it('says what it answered as one collapsed message row, and nothing about tokens', () => {
		const done = agent({
			viewId: 'done',
			agentId: 'choose-colour',
			description: 'Choose first colour',
			status: 'completed',
			startedAt: 1_000,
			completedAt: 2_700,
			tokens: 9_000,
			transcript: [
				{ id: '1', kind: 'assistant', text: 'thinking aloud' },
				{ id: '2', kind: 'assistant', text: 'Mavi\nçünkü gökyüzü' },
			],
		})
		expect(agentMessageRow(done)).toEqual({
			content: 'Message from @choose-colour',
			detail: ['Mavi', 'çünkü gökyüzü'],
			hint: '(ctrl+o to expand)',
		})
		expect(agentMessageRow(agent({ viewId: 'quiet', status: 'completed' }))).toBeUndefined()
	})

	it('closes the run with one line that names the task, never the result', () => {
		const base = { viewId: 'a', description: 'Count words in a.txt', startedAt: 0 }
		expect(agentNotice(agent({ ...base, status: 'completed', completedAt: 8_000 }))).toEqual({
			content: 'Agent "Count words in a.txt" finished · 8s',
			tone: 'ok',
		})
		expect(agentNotice(agent({ ...base, status: 'completed', completedAt: 64_000 })).content).toBe(
			'Agent "Count words in a.txt" finished · 1m 4s',
		)
		expect(
			agentNotice(
				agent({
					...base,
					status: 'failed',
					completedAt: 2_900,
					latestActivity: 'Provider refused the request',
				}),
			),
		).toEqual({
			content: 'Agent "Count words in a.txt" failed: Provider refused the request · 3s',
			tone: 'error',
		})
		expect(agentNotice(agent({ ...base, status: 'cancelled', completedAt: 500 }))).toEqual({
			content: 'Agent "Count words in a.txt" was stopped · 1s',
			tone: 'warn',
		})
	})

	// Reference wording (REA fn Qxt): `was stopped by user`, `was stopped by <the
	// main agent>` (Namzu's is `Namzu`), plain `was stopped` when nobody recorded
	// it, and `failed: <error>` with `Unknown error` as the fallback.
	it('says who stopped an agent, and why one failed', () => {
		const base = { viewId: 'a', description: 'Count words', startedAt: 0, completedAt: 4_000 }
		const stopped = (extra: Partial<SubagentActivity>) =>
			agentNotice(agent({ ...base, status: 'cancelled', ...extra })).content
		expect(stopped({ stoppedBy: 'user' })).toBe('Agent "Count words" was stopped by user · 4s')
		expect(stopped({ stoppedBy: 'parent' })).toBe('Agent "Count words" was stopped by Namzu · 4s')
		expect(stopped({})).toBe('Agent "Count words" was stopped · 4s')
		const failed = (extra: Partial<SubagentActivity>) =>
			agentNotice(agent({ ...base, status: 'failed', ...extra })).content
		expect(failed({})).toBe('Agent "Count words" failed: Unknown error · 4s')
		expect(failed({ latestActivity: 'Failed' })).toBe(
			'Agent "Count words" failed: Unknown error · 4s',
		)
		expect(
			failed({
				latestActivity: 'Failed',
				transcript: [{ id: 'a:failure', kind: 'system', text: 'Provider refused the request' }],
			}),
		).toBe('Agent "Count words" failed: Provider refused the request · 4s')
	})

	// Reference (REA fn Qxt: every caller is the background path): an agent the
	// parent waited on leaves the tool's own result, never a notification.
	it('leaves a waited-on agent as a Done line and a background one as a notification', () => {
		const waited = agent({
			viewId: 'w',
			agentId: 'general-purpose',
			description: 'Count words in a.txt',
			status: 'completed',
			startedAt: 0,
			completedAt: 8_000,
			toolCalls: 3,
			tokens: 12_100,
		})
		expect(reportsAsNotification(waited)).toBe(false)
		expect(agentDoneRows(waited)).toEqual({
			header: 'general-purpose (Count words in a.txt)',
			result: 'Done (3 tool uses · 12.1k tokens · 8s)',
		})
		expect(
			agentDoneRows(agent({ viewId: 'one', toolCalls: 1, completedAt: 1_000, startedAt: 0 }))
				.result,
		).toBe('Done (1 tool use · 0 tokens · 1s)')
		for (const kind of [{ background: true }, { released: true }, { resumed: true }] as const)
			expect(reportsAsNotification(agent({ viewId: 'n', ...kind }))).toBe(true)
	})

	it('draws what a running agent said as the same collapsed row, and frames it as the agent’s own words for the model', () => {
		const said = {
			agentId: 'count-words',
			description: 'Count words in a.txt',
			taskId: 'task-1',
			text: 'Found 6 words.\nStill sleeping.',
		}
		expect(childMessageRow(said)).toEqual({
			content: 'Message from @count-words',
			detail: ['Found 6 words.', 'Still sleeping.'],
			hint: '(ctrl+o to expand)',
		})
		const notice = childMessageNotice(said)
		expect(notice).toContain('Sub-agent count-words (Count words in a.txt) sent you a message')
		expect(notice).toContain('Found 6 words.')
		expect(notice).toContain('not operator instructions')
		expect(
			childMessageRow({ agentId: 'x', text: 'a\u001b]0;pwned\u0007' }).detail.join(''),
		).not.toContain('\u001b')
	})

	it('shows control characters in a child answer as text, never as terminal authority', () => {
		const row = agentMessageRow(
			agent({
				viewId: 'evil',
				status: 'completed',
				completedAt: 1_100,
				transcript: [{ id: '1', kind: 'assistant', text: 'ok\u001b]0;pwned\u0007' }],
			}),
		)
		expect(row?.detail.join('')).not.toContain('\u001b')
	})
})

describe('settle line', () => {
	it('names the agents of a turn that delegated and the time alone of one that did not', () => {
		const three = ['a', 'b', 'c'].map((viewId) => agent({ viewId }))
		expect(settleLine(38_200, three)).toBe('Worked for 38s · 3 agents')
		expect(settleLine(1_700, [agent({ viewId: 'solo' })])).toBe('Worked for 1.7s · 1 agent')
		expect(settleLine(5_000, [])).toBe('Worked for 5.0s')
		expect(settleLine(46_000, [])).toBe('Worked for 46s')
		// An answer that arrived at once closes without an account of it.
		expect(settleLine(2_999, [])).toBeUndefined()
	})

	it('closes a phased workflow with spend and failures, never its phases', () => {
		const phased = [
			agent({ viewId: 'a', phase: 'Phase 1', phaseId: 'p1', tokens: 9_000, status: 'completed' }),
			agent({ viewId: 'b', phase: 'Phase 1', phaseId: 'p1', tokens: 9_000, status: 'completed' }),
			agent({ viewId: 'c', phase: 'Phase 2', phaseId: 'p2', tokens: 9_050, status: 'failed' }),
		]
		expect(settleLine(12_000, phased)).toBe('Worked for 12s · 3 agents · 27.1k tokens · 1 failed')
		expect(settleLine(2_000, [agent({ viewId: 'x', phase: 'Only', phaseId: 'p' })])).toBe(
			'Worked for 2.0s · 1 agent',
		)
	})
})

describe('the cockpit of a phased workflow', () => {
	const phase = [
		agent({
			viewId: 'one',
			description: 'Birinci rengi seç',
			workflow: 'İki aşamalı cümle',
			latestActivity: 'Paleti okuyor',
			toolCalls: 3,
			tokens: 4_100,
			model: 'gpt-5.6-luna',
		}),
		agent({
			viewId: 'two',
			description: 'İkinci rengi seç',
			workflow: 'İki aşamalı cümle',
			status: 'queued',
		}),
	]

	describe('a workflow of several phases', () => {
		const at = Date.now()
		const workflow = 'Two-phase colour sentence'
		const phased = [
			agent({
				viewId: 'first',
				description: 'Choose first colour',
				workflow,
				phase: 'Phase 1',
				phaseId: 'p1',
				phaseOrder: 0,
				batchId: 'batch-1',
				status: 'completed',
				startedAt: at - 9_000,
				completedAt: at - 6_300,
				tokens: 9_000,
			}),
			agent({
				viewId: 'second',
				description: 'Choose second colour',
				workflow,
				phase: 'Phase 1',
				phaseId: 'p1',
				phaseOrder: 0,
				batchId: 'batch-1',
				status: 'completed',
				startedAt: at - 9_000,
				completedAt: at - 5_100,
				tokens: 9_000,
			}),
			agent({
				viewId: 'join',
				description: 'Join the two colours',
				workflow,
				phase: 'Phase 2',
				phaseId: 'p2',
				phaseOrder: 1,
				batchId: 'batch-2',
				startedAt: at - 1_000,
				latestActivity: 'Writing the sentence',
			}),
		]

		it('fills the cockpit the reference way: done count, time and spend, the pane named by its phase', async () => {
			const join = phased.find((member) => member.viewId === 'join')
			if (!join) throw new Error('fixture')
			mounted = await renderToScreen(
				<Box flexDirection="column" paddingX={1}>
					<AgentCockpit
						agents={phased}
						selectedPhaseId="p2"
						selectedId="join"
						focus="agents"
						terminalRows={24}
						terminalColumns={120}
					/>
				</Box>,
				{ cols: 120, rows: 24 },
			)
			const frame = mounted.viewport().join('\n')
			expect(frame).toMatch(/Two-phase colour sentence\s+2\/3 agents · \S+/u)
			expect(frame).toMatch(/┬ Phase 2 · 1 agent\s/u)
			expect(frame).toMatch(/❯● Join the two colours/u)
			await mounted.unmount()

			const finished = phased.map((member) =>
				member.viewId === 'join'
					? { ...member, status: 'completed' as const, completedAt: at, tokens: 9_000 }
					: member,
			)
			mounted = await renderToScreen(
				<Box flexDirection="column" paddingX={1}>
					<AgentCockpit
						agents={finished}
						selectedPhaseId="p1"
						selectedId="first"
						focus="phases"
						terminalRows={24}
						terminalColumns={120}
					/>
				</Box>,
				{ cols: 120, rows: 24 },
			)
			const levelOne = mounted.viewport().join('\n')
			expect(levelOne).toMatch(/3\/3 agents · 9\.0s · done/u)
			expect(levelOne).toMatch(/❯ ✔\s+Phase 1\s+2\/2/u)
			expect(levelOne).toMatch(/✔\s+Phase 2\s+1\/1/u)
			await mounted.unmount()

			mounted = await renderToScreen(
				<Box flexDirection="column" paddingX={1}>
					<AgentCockpit
						agents={phased}
						selectedPhaseId="p2"
						selectedId="join"
						focus="agents"
						terminalRows={16}
						terminalColumns={40}
					/>
				</Box>,
				{ cols: 40, rows: 16 },
			)
			const narrow = mounted.viewport()
			expect(narrow.join('\n')).toMatch(/Two-phase colour[\s\S]*2\/3 agents/u)
			for (const row of narrow) expect(stringWidth(row)).toBeLessThanOrEqual(40)
		})
	})
})

describe('the waiting line', () => {
	const wait = (id: string, on: string) => ({
		id,
		label: `Waiting · ${on}`,
		startedAt: Date.now(),
		waitingOn: on,
	})

	it('folds waits on agents into one line, and never hides real work behind them', () => {
		expect(waitingLine([wait('a', 'Birinci'), wait('b', 'İkinci')])).toBe(
			'Waiting for 2 agents to finish',
		)
		expect(waitingLine([wait('a', 'Birinci')])).toBe('Waiting for Birinci')
		expect(
			waitingLine([wait('a', 'Birinci'), { id: 'bash', label: 'Bash(ls)', startedAt: Date.now() }]),
		).toBeUndefined()
		expect(waitingLine([])).toBeUndefined()
	})

	it('draws the folded line under Working at 40 columns', async () => {
		mounted = await renderToScreen(
			<LiveActivity
				activeTools={[wait('a', 'Birinci'), wait('b', 'İkinci')]}
				working
				interruptible
				animate={false}
			/>,
			{ cols: 40, rows: 6 },
		)
		const text = mounted.viewport().join('\n')
		expect(text).toContain('✻ Waiting for 2 agents to finish')
		expect(text).not.toContain('Waiting · Birinci')
	})
})

describe('the effort slider', () => {
	const labels = ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'max + hypermode (workflows)']
	const options = labels.map((label, index) => ({
		label,
		description: index === 6 ? 'Off · delegates to parallel agents by default' : '',
		current: index === 3,
	}))

	it('lays stops out from their widths, and gives way to the list where they do not fit', () => {
		const layout = effortSliderLayout(labels, 118)
		expect(layout?.separator).toBeGreaterThan(layout?.starts[5] ?? 0)
		expect(layout?.starts[6]).toBe((layout?.separator ?? 0) + 2)
		expect(effortSliderLayout(labels, 59)).toBeUndefined()
		const eight = [
			'default',
			'none',
			'minimal',
			'low',
			'medium',
			'high',
			'xhigh',
			'max',
			'ultra',
			'ultra + hypermode (workflows)',
		]
		expect(effortSliderLayout(eight, 60)).toBeUndefined()
		expect(effortSliderLayout(eight, 100)).toBeDefined()
	})

	it.each([
		{ selected: 3, stop: 'high' },
		{ selected: 6, stop: 'max + hypermode (workflows)' },
	])('puts the caret under the $stop stop', async ({ selected, stop }) => {
		const layout = effortSliderLayout(labels, 98)
		if (!layout) throw new Error('fixture must fit')
		mounted = await renderToScreen(
			<EffortSlider
				title="Reasoning for gpt-5.6-luna"
				options={options}
				selected={selected}
				layout={layout}
				columns={98}
			/>,
			{ cols: 100, rows: 12 },
		)
		const rows = mounted.viewport()
		const ruler = rows.findIndex((row) => row.includes('▲'))
		const caret = [...(rows[ruler] ?? '')].indexOf('▲')
		const labelRow = rows[ruler + 1] ?? ''
		const start = [...labelRow].join('').indexOf(stop)
		expect(caret).toBeGreaterThanOrEqual(start)
		expect(caret).toBeLessThan(start + stop.length)
		const text = rows.join('\n')
		expect(text).toContain('Off · delegates to parallel agents by default')
		expect(text).toContain('←/→ adjust')
		expect(text).not.toContain('effort hypermode')
		expect(text.includes('Spends the most tokens')).toBe(selected === 6)
	})

	it('keeps the sub-label and the warning whole on an 80-column terminal', async () => {
		// App hands the slider the terminal less two columns, and lays it out on the same.
		const columns = 78
		const layout = effortSliderLayout(labels, columns)
		if (!layout) throw new Error('fixture must fit')
		const heights: number[] = []
		for (const selected of [0, 6]) {
			mounted = await renderToScreen(
				<EffortSlider
					title="t"
					options={options}
					selected={selected}
					layout={layout}
					columns={columns}
				/>,
				{ cols: 80, rows: 16 },
			)
			const rows = mounted.viewport()
			const text = rows.join('\n')
			expect(text).toContain('max + hypermode (workflows)')
			expect(text).toContain('Off · delegates to parallel agents by default')
			expect(rows.every((row) => stringWidth(row.trimEnd()) <= 78)).toBe(true)
			if (selected === 6) {
				const flat = rows.map((row) => row.trim()).join(' ')
				expect(flat).toContain(
					'Spends the most tokens and time; use it for work that splits into independent parts.',
				)
				expect(text).not.toContain('…')
			}
			heights.push(rows.findIndex((row) => row.includes('←/→ adjust')))
			await mounted.unmount()
			mounted = undefined
		}
		// The warning's rows are held when it is not shown: the caret never resizes the slider.
		expect(heights[0]).toBe(heights[1])
	})

	it('draws hypermode in its own violet', async () => {
		const layout = effortSliderLayout(labels, 98)
		if (!layout) throw new Error('fixture must fit')
		mounted = await renderToScreen(
			<EffortSlider title="t" options={options} selected={0} layout={layout} columns={98} />,
			{ cols: 100, rows: 12 },
		)
		expect(mounted.writes().join('')).toMatch(
			// biome-ignore lint/suspicious/noControlCharactersInRegex: matches the escape character that starts a terminal control sequence, on purpose.
			/\u001b\[38;5;141m[^\u001b]*max \+ hypermode \(workflows\)/u,
		)
	})
})

describe('hypermode on the message box', () => {
	it('names the mode once on the composer at 80, 40 and 24 columns', async () => {
		for (const cols of [80, 40, 24]) {
			mounted = await renderToScreen(
				<Box flexDirection="column">
					<ComposerFrame focus mode="hypermode">
						{null}
					</ComposerFrame>
					<StatusBar provider={null} model={null} state="idle" />
				</Box>,
				{ cols, rows: 7 },
			)
			const visible = mounted.viewport().join('\n')
			expect(visible.match(/hypermode/gu)).toHaveLength(1)
			expect(visible.split('\n').find((row) => row.startsWith('─'))).toContain('hypermode')
			expect(visible.split('\n').find((row) => row.includes('shift+tab'))).not.toContain(
				'hypermode',
			)
			await mounted.unmount()
			mounted = undefined
		}
	})

	it('ends the upper rule with the mode label, full width, on narrow screens', async () => {
		mounted = await renderToScreen(
			<ComposerFrame focus mode="hypermode">
				{null}
			</ComposerFrame>,
			{ cols: 60, rows: 6 },
		)
		const top = mounted.viewport().find((row) => row.includes('hypermode')) ?? ''
		expect(top).toMatch(/^─+ hypermode ─$/u)
		expect([...top]).toHaveLength(60)
		await mounted.unmount()
		mounted = await renderToScreen(
			<ComposerFrame focus mode="hypermode">
				{null}
			</ComposerFrame>,
			{ cols: 24, rows: 6 },
		)
		const narrow = mounted.viewport().find((row) => row.includes('hypermode')) ?? ''
		expect(narrow).toMatch(/^─+ hypermode ─$/u)
		expect([...narrow]).toHaveLength(24)
	})

	it('keeps the resting rule plain and the label visible without colour', async () => {
		vi.stubEnv('NO_COLOR', undefined)
		vi.stubEnv('FORCE_COLOR', '3')
		vi.stubEnv('TERM', 'xterm-256color')
		try {
			mounted = await renderToScreen(
				<ComposerFrame focus mode="hypermode">
					{null}
				</ComposerFrame>,
				{ cols: 80, rows: 6 },
			)
			const coloured = mounted.writes().join('')
			expect(coloured).toContain('\u001b[38;5;141m')
			expect(coloured).not.toContain('\u001b[38;5;110m─')
			await mounted.unmount()
			vi.stubEnv('NO_COLOR', '1')
			mounted = await renderToScreen(
				<ComposerFrame focus mode="hypermode">
					{null}
				</ComposerFrame>,
				{ cols: 80, rows: 6 },
			)
			const plain = mounted.writes().join('')
			expect(plain).not.toContain('38;5;183m')
			expect(mounted.viewport().join('\n')).toMatch(/─+ hypermode ─/u)
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it('names the mode in violet at the composer top right', async () => {
		mounted = await renderToScreen(
			<ComposerFrame focus mode="hypermode">
				{null}
			</ComposerFrame>,
			{ cols: 100, rows: 4 },
		)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: matches the escape character that starts a terminal control sequence, on purpose.
		expect(mounted.writes().join('')).toMatch(/\u001b\[38;5;141m hypermode /u)
	})
})

describe('a repeated failure', () => {
	it('reads as failed again when the reason is the one already reported', () => {
		const base = {
			viewId: 'a',
			description: 'Audit the config',
			startedAt: 0,
			completedAt: 6_000,
			status: 'failed' as const,
			transcript: [
				{
					id: 'a:failure',
					kind: 'system' as const,
					text: 'The provider could not use this request. Start the task again, or choose another model.',
				},
			],
		}
		const first = agentNotice(agent(base))
		expect(first.content).toBe(
			'Agent "Audit the config" failed: The provider could not use this request. Start the task again, or choose another model. · 6s',
		)
		const again = agentNotice(agent(base), 10_000, failureReason(agent(base)))
		expect(again.content).toBe('Agent "Audit the config" failed again · 6s')
		expect(agentNotice(agent(base), 10_000, 'Something else.').content).toContain('failed: ')
	})
})
