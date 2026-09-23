/**
 * The delegated-work surfaces aligned with the reference terminal: the
 * borderless rail tree, the rows delegated work leaves in the conversation,
 * the folded waiting line, the effort slider and the orchestrate tag on the
 * message box. Each is checked at a comfortable width, at 40 columns, and
 * with Turkish text, whose dotted/dotless i and cedilla letters are the
 * cheapest way to catch a width or case-folding assumption.
 */

import { createRequire } from 'node:module'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import stringWidth from 'string-width'

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import { AgentTaskPanel } from '../AgentExplorer.js'
import { ComposerFrame } from '../ComposerFrame.js'
import { EffortSlider, effortSliderLayout } from '../EffortSlider.js'
import { LiveActivity, waitingLine } from '../LiveActivity.js'
import { StatusBar } from '../StatusBar.js'
import { completionRow, launchReceipt, settleLine } from '../agent-transcript-rows.js'
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

function agent(input: Partial<SubagentActivity> & Pick<SubagentActivity, 'viewId'>): SubagentActivity {
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
	it('names every agent of one batch under one line, in start order', () => {
		const receipt = launchReceipt([
			agent({ viewId: 'b', description: 'İkinci rengi seç', startedAt: 2_000, workflow: 'İki aşamalı cümle', phase: 'Aşama 1' }),
			agent({ viewId: 'a', description: 'Birinci rengi seç', startedAt: 1_000, workflow: 'İki aşamalı cümle', phase: 'Aşama 1' }),
		])
		expect(receipt.content.split('\n')).toEqual([
			'Launched 2 agents · İki aşamalı cümle / Aşama 1 (ctrl+t to manage)',
			'├ Birinci rengi seç',
			'└ İkinci rengi seç',
		])
	})

	it('names one agent inline, and leaves the unlabelled defaults out', () => {
		expect(launchReceipt([agent({ viewId: 'solo', description: 'Join the colours' })]).content).toBe(
			'Launched Join the colours (ctrl+t to manage)',
		)
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

describe('completion row', () => {
	it('says time and spend, and attaches the answer as its collapsed body', () => {
		const row = completionRow(
			agent({
				viewId: 'done',
				description: 'Choose first colour',
				status: 'completed',
				startedAt: 1_000,
				completedAt: 2_700,
				tokens: 9_000,
				transcript: [
					{ id: '1', kind: 'assistant', text: 'thinking aloud' },
					{ id: '2', kind: 'assistant', text: 'Mavi\nçünkü gökyüzü' },
				],
			}),
		)
		expect(row).toEqual({
			ok: true,
			content: 'Choose first colour · 1.7s · 9.0k tokens',
			detail: ['Mavi', 'çünkü gökyüzü'],
			hint: 'ctrl+o result · ctrl+t details',
		})
	})

	it('names a failure without colour, and offers no result it does not have', () => {
		const failed = completionRow(
			agent({
				viewId: 'f',
				description: 'Choose second colour',
				status: 'failed',
				startedAt: 0,
				completedAt: 2_900,
				latestActivity: 'Provider refused the request',
			}),
		)
		expect(failed.ok).toBe(false)
		expect(failed.content).toBe('Choose second colour · failed after 2.9s · Provider refused the request')
		expect(failed.hint).toBe('ctrl+t details')
		const cancelled = completionRow(
			agent({ viewId: 'c', description: 'x', status: 'cancelled', startedAt: 0, completedAt: 500 }),
		)
		expect(cancelled.content).toBe('x · cancelled after 0.5s')
	})

	it('shows control characters in a child answer as text, never as terminal authority', () => {
		const row = completionRow(
			agent({
				viewId: 'evil',
				status: 'completed',
				completedAt: 1_100,
				transcript: [{ id: '1', kind: 'assistant', text: 'ok\u001b]0;pwned\u0007' }],
			}),
		)
		expect(row.detail.join('')).not.toContain('\u001b')
	})
})

describe('settle line', () => {
	it('is written only for a turn that delegated', () => {
		expect(settleLine(38_200, 3)).toBe('Worked for 38s · 3 agents')
		expect(settleLine(1_700, 1)).toBe('Worked for 1.7s · 1 agent')
		expect(settleLine(5_000, 0)).toBeUndefined()
	})
})

describe('the rail tree', () => {
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
		agent({ viewId: 'two', description: 'İkinci rengi seç', workflow: 'İki aşamalı cümle', status: 'queued' }),
	]

	it('draws a header and one branch per agent with its activity beneath, and no box', async () => {
		mounted = await renderToScreen(
			<AgentTaskPanel agents={phase} terminalRows={40} terminalColumns={120} />,
			{ cols: 120, rows: 12 },
		)
		const rows = mounted.viewport().filter((row) => row.trim().length > 0)
		expect(rows[0]).toMatch(/^● İki aşamalı cümle · 1 running · 1 queued · ↓ \/ ctrl\+t$/u)
		expect(rows[1]).toMatch(/^ {2}├ ● Birinci rengi seç\s+\S+\s+3 tools · 4\.1k · gpt-5\.6-luna$/u)
		expect(rows[2]).toBe('  │   ⎿ Paleti okuyor')
		expect(rows[3]).toMatch(/^ {2}└ ◌ İkinci rengi seç\s+queued$/u)
		expect(rows[4]).toBe('      ⎿ Waiting for a slot')
		expect(rows.join('\n')).not.toMatch(/[┌┐┘]/u)
		expect(rows.join('\n')).not.toContain('Delegated work')
	})

	it('keeps activity inline on a short terminal, one row per agent', async () => {
		mounted = await renderToScreen(
			<AgentTaskPanel agents={phase} terminalRows={20} terminalColumns={100} />,
			{ cols: 100, rows: 8 },
		)
		const text = mounted.viewport().join('\n')
		expect(text).not.toContain('⎿')
		expect(text).toContain('· Paleti okuyor')
	})

	it('fits 40 columns without wrapping a row', async () => {
		mounted = await renderToScreen(
			<AgentTaskPanel agents={phase} terminalRows={30} terminalColumns={40} />,
			{ cols: 40, rows: 10 },
		)
		const rows = mounted.viewport().filter((row) => row.trim().length > 0)
		expect(rows[0]).toContain('● İki aşamalı cümle · 2/2')
		expect(rows).toHaveLength(5)
		expect(rows.join('\n')).toContain('Birinci rengi seç')
		expect(rows.join('\n')).not.toContain('gpt-5.6-luna')
	})

	it('reduces to its header line while a review is open, naming no key the review holds', async () => {
		mounted = await renderToScreen(
			<AgentTaskPanel agents={phase} terminalRows={40} terminalColumns={100} compact />,
			{ cols: 100, rows: 6 },
		)
		const rows = mounted.viewport().filter((row) => row.trim().length > 0)
		expect(rows).toEqual(['● İki aşamalı cümle · 1 running · 1 queued'])
	})
})

describe('the waiting line', () => {
	const wait = (id: string, on: string) => ({ id, label: `Waiting · ${on}`, startedAt: Date.now(), waitingOn: on })

	it('folds waits on agents into one line, and never hides real work behind them', () => {
		expect(waitingLine([wait('a', 'Birinci'), wait('b', 'İkinci')])).toBe('Waiting for 2 agents to finish')
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
	const labels = ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'orchestrate']
	const options = labels.map((label, index) => ({
		label,
		description: '',
		current: index === 3,
	}))

	it('lays stops out from their widths, and gives way to the list where they do not fit', () => {
		const layout = effortSliderLayout(labels, 118)
		expect(layout?.separator).toBeGreaterThan(layout?.starts[5] ?? 0)
		expect(layout?.starts[6]).toBe((layout?.separator ?? 0) + 2)
		expect(effortSliderLayout(labels, 59)).toBeUndefined()
		const eight = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'orchestrate']
		expect(effortSliderLayout(eight, 60)).toBeUndefined()
		expect(effortSliderLayout(eight, 100)).toBeDefined()
	})

	it.each([
		{ selected: 3, stop: 'high' },
		{ selected: 6, stop: 'orchestrate' },
	])('puts the caret under the $stop stop', async ({ selected, stop }) => {
		const layout = effortSliderLayout(labels, 98)
		if (!layout) throw new Error('fixture must fit')
		mounted = await renderToScreen(
			<EffortSlider title="Reasoning for gpt-5.6-luna" options={options} selected={selected} layout={layout} columns={98} highest="max" />,
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
		expect(text).toContain('max + delegate by default')
		expect(text).toContain('←/→ adjust')
		expect(text).not.toContain('effort orchestrate')
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
				<EffortSlider title="t" options={options} selected={selected} layout={layout} columns={columns} highest="max" />,
				{ cols: 80, rows: 16 },
			)
			const rows = mounted.viewport()
			const text = rows.join('\n')
			expect(text).toContain('max + delegate by default')
			expect(rows.every((row) => stringWidth(row.trimEnd()) <= 78)).toBe(true)
			if (selected === 6) {
				const flat = rows.map((row) => row.trim()).join(' ')
				expect(flat).toContain('Spends the most tokens and time; use it for work that splits into independent parts.')
				expect(text).not.toContain('…')
			}
			heights.push(rows.findIndex((row) => row.includes('←/→ adjust')))
			await mounted.unmount()
			mounted = undefined
		}
		// The warning's rows are held when it is not shown: the caret never resizes the slider.
		expect(heights[0]).toBe(heights[1])
	})

	it('draws orchestrate in its own violet', async () => {
		const layout = effortSliderLayout(labels, 98)
		if (!layout) throw new Error('fixture must fit')
		mounted = await renderToScreen(
			<EffortSlider title="t" options={options} selected={0} layout={layout} columns={98} highest="max" />,
			{ cols: 100, rows: 12},
		)
		expect(mounted.writes().join('')).toMatch(/\u001b\[38;5;141m[^\u001b]*orchestrate/u)
	})
})

describe('orchestrate on the message box and the footer', () => {
	it('tags the top border, and leaves it plain below 40 columns', async () => {
		mounted = await renderToScreen(
			<ComposerFrame focus mode="orchestrate">
				<></>
			</ComposerFrame>,
			{ cols: 60, rows: 6 },
		)
		const top = mounted.viewport().find((row) => row.includes('MESSAGE')) ?? mounted.viewport().join('\n')
		expect(top).toMatch(/^┌─ MESSAGE ─+ orchestrate ─┐$/u)
		expect([...top]).toHaveLength(60)
		await mounted.unmount()
		mounted = await renderToScreen(
			<ComposerFrame focus mode="orchestrate">
				<></>
			</ComposerFrame>,
			{ cols: 39, rows: 6 },
		)
		const narrow = mounted.viewport().find((row) => row.includes('MESSAGE')) ?? ''
		expect(narrow).not.toContain('orchestrate')
		expect([...narrow]).toHaveLength(39)
	})

	it('draws the still gradient only where colour is allowed', async () => {
		vi.stubEnv('NO_COLOR', undefined)
		vi.stubEnv('FORCE_COLOR', '3')
		vi.stubEnv('TERM', 'xterm-256color')
		try {
			mounted = await renderToScreen(
				<ComposerFrame focus mode="orchestrate">
					<></>
				</ComposerFrame>,
				{ cols: 80, rows: 6 },
			)
			const coloured = mounted.writes().join('')
			expect(coloured).toContain('\u001b[38;5;110m─')
			expect(coloured).toContain('\u001b[38;5;221m─')
			await mounted.unmount()
			vi.stubEnv('NO_COLOR', '1')
			mounted = await renderToScreen(
				<ComposerFrame focus mode="orchestrate">
					<></>
				</ComposerFrame>,
				{ cols: 80, rows: 6 },
			)
			const plain = mounted.writes().join('')
			expect(plain).not.toContain('38;5;110m')
			expect(mounted.viewport().join('\n')).toMatch(/┌─ MESSAGE ─+ orchestrate ─┐/u)
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it('names the mode in violet in the footer', async () => {
		mounted = await renderToScreen(
			<StatusBar cwd="/çalışma" provider="codex" model="gpt-5.6-luna" effort="max" orchestrate state="idle" />,
			{ cols: 100, rows: 3},
		)
		expect(mounted.writes().join('')).toMatch(/\u001b\[38;5;141morchestrate/u)
	})
})
