/**
 * Starting a workflow is reviewed like a destructive call: the operator sees
 * what it is called, what it is for, its phases, what it may start and the
 * script itself (collapsed, whole on demand) and answers once.
 */

import { describe, expect, it } from 'vitest'

import {
	PermissionOverlay,
	permissionAnswers,
	permissionChoices,
	permissionQuestion,
	permissionTitle,
} from '../PermissionOverlay.js'
import { buildPermissionReview, buildPermissionSummary } from '../permission-review.js'
import { renderToScreen } from './support/screen.js'

const META =
	"export const meta = { name: 'audit', description: 'Scan, then fix', phases: [{ title: 'Scan' }, { title: 'Fix', detail: 'safe fixes only' }] }"

const SHORT = `${META}\nphase('Scan')\nreturn 1`
const LONG = [
	META,
	"phase('Scan')",
	"const found = await parallel([1, 2, 3].map((n) => () => agent('scan ' + n, { label: 'scan:' + n })))",
	"phase('Fix')",
	"const fixed = await parallel(found.map((f, i) => () => agent('fix ' + f, { label: 'fix:' + i })))",
	"log('done')",
	'// line 7',
	'// line 8',
	'// line 9',
	'// line 10',
	'return { found, fixed }',
].join('\n')

function call(input: Record<string, unknown>) {
	return [{ id: 'w1', name: 'workflow', input, isDestructive: false }]
}

function summaryOf(input: Record<string, unknown>) {
	const review = buildPermissionReview(call(input))
	if (!review.ok) throw new Error('fixture must fit the approval envelope')
	return { review: review.text, summary: buildPermissionSummary(review.text) }
}

describe('the review of a workflow start', () => {
	it('names it, says what it is for, lists the phases and the limits', () => {
		const { summary } = summaryOf({ script: SHORT })
		expect(summary.complete).toBe(true)
		for (const line of [
			'Workflow: audit',
			'Purpose: Scan, then fix',
			'1. Scan',
			'2. Fix — safe fixes only',
			'Runs in the background',
		]) {
			expect(summary.text).toContain(line)
		}
		expect(summary.text).toMatch(/Agents: up to \d+ at a time, 200 in all/)
	})

	it('shows a short script whole and has nothing further to expand', () => {
		const { summary } = summaryOf({ script: SHORT })
		expect(summary.text).toContain('Script · 3 lines')
		expect(summary.text).toContain("phase('Scan')")
		expect(summary.expandedText).toBeUndefined()
	})

	it('collapses a long script to its first lines and keeps all of it for the expanded view', () => {
		const { summary } = summaryOf({ script: LONG })
		expect(summary.text).toContain('Script · 11 lines')
		expect(summary.text).toContain('… 3 more lines')
		expect(summary.text).not.toContain('// line 10')
		expect(summary.expandedText).toContain('// line 10')
		expect(summary.expandedText).toContain('return { found, fixed }')
		expect(summary.expandedText).not.toContain('more lines')
	})

	it('shows the arguments and the summary the model gave', () => {
		const { summary } = summaryOf({
			script: SHORT,
			args: { packages: ['core', 'cli'] },
			description: 'Audit two packages',
		})
		expect(summary.text).toContain('Arguments: {"packages":["core","cli"]}')
		expect(summary.text).toContain('Shown as: Audit two packages')
	})

	it('still reviews a script whose meta cannot be read, and says so', () => {
		const { summary } = summaryOf({ script: "const n = 'x'\nexport const meta = { name: n }" })
		expect(summary.complete).toBe(true)
		expect(summary.text).toContain('its name could not be read')
		expect(summary.text).toContain('const n')
	})

	it('opens an unknown shape exact-first rather than hide a field', () => {
		const { summary } = summaryOf({ script: SHORT, sneaky: true })
		expect(summary.complete).toBe(false)
		expect(summary.text).toContain('sneaky')
	})
})

describe('the box around it', () => {
	const toolCalls = call({ script: LONG })

	it('is titled and asked as a workflow, with its own answers', () => {
		expect(permissionTitle(toolCalls)).toBe('Start a workflow')
		expect(permissionQuestion(toolCalls)).toBe('Do you want to start this workflow?')
		expect(permissionChoices(toolCalls)).toEqual([
			'Start this workflow',
			'Start and allow all tools for this conversation',
			'Do not start',
		])
		expect(permissionAnswers(toolCalls, { batchOnly: true }).map((a) => a.kind)).toEqual([
			'approve',
			'reject',
		])
	})

	it('draws the collapsed review, then the whole script on d', async () => {
		const { review, summary } = summaryOf({ script: LONG })
		const props = { toolCalls, review, summary, columns: 110, rows: 60 }
		const collapsed = await renderToScreen(<PermissionOverlay {...props} detailsOpen={false} />, {
			cols: 110,
			rows: 60,
		})
		try {
			await collapsed.waitForRender()
			const text = collapsed.viewport().join('\n')
			expect(text).toContain('Start a workflow')
			expect(text).toContain('Workflow: audit')
			expect(text).toContain('… 3 more lines')
			expect(text).not.toContain('// line 10')
			expect(text).toContain('Do you want to start this workflow?')
			expect(text).toContain('❯ 1. Start this workflow')
			expect(text).toMatch(/d (read the whole )?script/)
		} finally {
			await collapsed.unmount()
		}
		const expanded = await renderToScreen(<PermissionOverlay {...props} detailsOpen />, {
			cols: 110,
			rows: 60,
		})
		try {
			await expanded.waitForRender()
			const text = expanded.viewport().join('\n')
			expect(text).toContain('Workflow script')
			expect(text).toContain('// line 10')
			expect(text).toContain('return { found, fixed }')
			expect(text).toMatch(/d collapse/)
		} finally {
			await expanded.unmount()
		}
	})
})

describe('the descriptions of the other tools are untouched', () => {
	it('still names an Agent start as one', () => {
		const calls = [
			{
				id: 'a',
				name: 'Agent',
				input: { description: 'x', prompt: 'y' },
				isDestructive: false,
			},
		]
		expect(permissionTitle(calls)).toBe('Start an agent')
		expect(permissionChoices(calls)[0]).toBe('Start this agent')
	})
})
