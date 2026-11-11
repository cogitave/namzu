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
	permissionReviewSource,
	permissionTitle,
} from '../PermissionOverlay.js'
import {
	MAX_WORKFLOW_REVIEW_BYTES,
	buildPermissionReview,
	buildPermissionSummary,
	reviewPageRows,
	workflowReviewPageRows,
} from '../permission-review.js'
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

function summaryOf(
	input: Record<string, unknown>,
	context: Parameters<typeof buildPermissionSummary>[1] = {},
) {
	const review = buildPermissionReview(call(input))
	if (!review.ok) throw new Error('fixture must fit the approval envelope')
	return {
		review: review.text,
		summary: buildPermissionSummary(review.text, context),
	}
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
		expect(summary.text).toMatch(/Agents: up to \d+ at a time, 1000 in all/)
	})

	it('shows a short script whole and `d` reads the same script verbatim, never the wire JSON', () => {
		const { summary } = summaryOf({ script: SHORT })
		expect(summary.text).toContain('Script · 3 lines')
		expect(summary.text).toContain("phase('Scan')")
		expect(summary.expandedText).toContain("phase('Scan')")
		expect(summary.expandedText).toContain('return 1')
		expect(summary.expandedText).not.toContain('"calls"')
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
		const { summary } = summaryOf({
			script: "const n = 'x'\nexport const meta = { name: n }",
		})
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

describe('the limits in force', () => {
	it('are the configured ones, not the defaults', () => {
		const { summary } = summaryOf(
			{ script: SHORT },
			{ workflowLimits: { maxConcurrency: 3, maxAgents: 40 } },
		)
		expect(summary.text).toContain('Agents: up to 3 at a time, 40 in all')
	})
})

describe('the box around it', () => {
	const toolCalls = call({ script: LONG })

	it('is titled and asked as a workflow, with its own answers', () => {
		expect(permissionTitle(toolCalls)).toBe('Start a workflow')
		expect(permissionQuestion(toolCalls)).toBe('Do you want to start this workflow?')
		expect(permissionChoices(toolCalls)).toEqual(['Start this workflow', 'Do not start'])
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

describe('a large script', () => {
	const big = [
		META,
		...Array.from({ length: 6000 }, (_, i) => `// step ${i} ${'x'.repeat(30)}`),
		'return 1',
	].join('\n')

	it('is reviewed, not refused for its size, collapsed to its first lines', () => {
		expect(Buffer.byteLength(big)).toBeGreaterThan(200_000)
		const { summary, review } = summaryOf({ script: big })
		expect(review.length).toBeGreaterThan(200_000)
		expect(summary.complete).toBe(true)
		expect(summary.text).toContain('Script · 6002 lines')
		expect(summary.text).toContain('… 5994 more lines')
		expect(summary.expandedText).toContain('// step 5999')
	})

	it('no longer refuses a large batch of ordinary calls: it is shown bounded and withheld', () => {
		const result = buildPermissionReview([
			{
				id: 'b',
				name: 'bash',
				input: { command: 'x'.repeat(9000) },
				isDestructive: true,
			},
		])
		expect(result).toMatchObject({ ok: true, withheld: [] })
	})

	it('withholds a workflow value past the 640 KiB per-value ceiling', () => {
		const result = buildPermissionReview([
			{
				id: 'w',
				name: 'workflow',
				input: { script: 'x'.repeat(MAX_WORKFLOW_REVIEW_BYTES + 1) },
				isDestructive: false,
			},
		])
		expect(result).toMatchObject({
			ok: true,
			withheld: [{ index: 0, name: 'workflow' }],
		})
	})

	it('pages the whole script in the expanded view', async () => {
		const toolCalls = call({ script: big })
		const { review, summary } = summaryOf({ script: big })
		const screen = await renderToScreen(
			<PermissionOverlay
				toolCalls={toolCalls}
				review={review}
				summary={summary}
				detailsOpen
				reviewOffset={5000}
				columns={110}
				rows={40}
			/>,
			{ cols: 110, rows: 40 },
		)
		try {
			await screen.waitForRender()
			const text = screen.viewport().join('\n')
			expect(text).toContain('Workflow script')
			expect(text).toMatch(/rows 5001-\d+\/\d+ · PgUp\/PgDn page · Home\/End/)
			expect(text).toMatch(/\/\/ step \d{4}/)
		} finally {
			await screen.unmount()
		}
	})

	it('clips long arguments when collapsed and keeps them whole under d', () => {
		const args = { list: Array.from({ length: 400 }, (_, i) => `item-${i}`) }
		const { summary } = summaryOf({ script: SHORT, args })
		expect(summary.text).toContain('more characters (d shows all of it)')
		expect(summary.text).not.toContain('item-399')
		expect(summary.expandedText).toContain('item-399')
	})
})

describe('the review at a narrow width', () => {
	it('keeps the key that reads the script, and breaks lines between words', async () => {
		const toolCalls = call({ script: SHORT })
		const { review, summary } = summaryOf({ script: SHORT })
		const screen = await renderToScreen(
			<PermissionOverlay
				toolCalls={toolCalls}
				review={review}
				summary={summary}
				detailsOpen={false}
				columns={60}
				rows={40}
			/>,
			{ cols: 60, rows: 40 },
		)
		try {
			await screen.waitForRender()
			const text = screen.viewport().join('\n')
			expect(text).toMatch(/d script|d read the whole script/)
			// A word is never split across two rows (`r / ail`, `t / he`).
			expect(text).not.toMatch(/\bt\s*\n\s*(↳ )?he\b/)
			expect(text).toMatch(/Agent[\s│]+(↳\s*)?call/)
		} finally {
			await screen.unmount()
		}
	})
})

const PHASED = [
	"export const meta = { name: 'package-audit', description: 'Scan three packages, run four checks on them, then write one summary', phases: [",
	"{ title: 'Scan', detail: 'read each package and note what it exports' },",
	"{ title: 'Check', detail: 'four independent checks, run side by side' },",
	"{ title: 'Report' } ] }",
]
	.join('\n')
	.concat(`\n${Array.from({ length: 16 }, (_, i) => `// step ${i}`).join('\n')}\nreturn 1`)

async function showReview(columns: number, rows: number, detailsOpen = false, reviewOffset = 0) {
	const toolCalls = call({
		script: PHASED,
		args: { packages: ['core', 'web'] },
	})
	const { review, summary } = summaryOf({
		script: PHASED,
		args: { packages: ['core', 'web'] },
	})
	const screen = await renderToScreen(
		<PermissionOverlay
			toolCalls={toolCalls}
			review={review}
			summary={summary}
			detailsOpen={detailsOpen}
			reviewOffset={reviewOffset}
			columns={columns}
			rows={rows}
		/>,
		{ cols: columns, rows: Math.max(rows, 60) },
	)
	await screen.waitForRender()
	const text = screen.viewport().join('\n')
	await screen.unmount()
	return text
}

describe('the page of a workflow review', () => {
	it('is the terminal rows less the frame, the question, the answers and the line above', () => {
		// 8 rows of frame and key line, 2 answers, 4 rows left to the conversation.
		expect(workflowReviewPageRows(30, 2)).toBe(16)
		expect(workflowReviewPageRows(40, 2)).toBe(26)
		expect(workflowReviewPageRows(30, 3)).toBe(15)
	})

	it('keeps a floor on a short terminal and a ceiling on a tall one', () => {
		expect(workflowReviewPageRows(16, 2)).toBe(6)
		expect(workflowReviewPageRows(10, 2)).toBe(6)
		expect(workflowReviewPageRows(200, 2)).toBe(30)
	})

	it('is only the workflow review that takes it; other reviews keep theirs', () => {
		const other = [{ name: 'bash' }]
		expect(reviewPageRows([{ name: 'workflow' }], 30)).toBe(16)
		expect(reviewPageRows(other, 30)).toBe(12)
	})
})

describe('what the first screen holds', () => {
	it('shows the name, the purpose, the phases with their details, the limits and the start of the script at 100x30', async () => {
		const text = await showReview(100, 30)
		expect(text).toContain('Workflow: package-audit')
		expect(text).toContain('2. Check — four independent checks, run side by side')
		expect(text).toContain('Agents: up to')
		expect(text).toContain('Script · 21 lines')
		// More of the script than the old 12-row pager reached.
		expect(text).toContain("{ title: 'Report' } ] }")
		expect(text).toMatch(/rows 1-16\/\d+/)
		expect(text).not.toContain('Phase details')
	})

	it('puts the name, purpose, phase titles and limits first on a 16-row terminal, details after', async () => {
		const text = await showReview(100, 16)
		const at = (needle: string) => text.indexOf(needle)
		expect(at('Workflow: package-audit')).toBeGreaterThan(-1)
		expect(at('Purpose:')).toBeGreaterThan(at('Workflow:'))
		expect(at('Phases: 1. Scan · 2. Check · 3. Report')).toBeGreaterThan(at('Purpose:'))
		expect(at('Agents: up to')).toBeGreaterThan(at('Phases:'))
		// Details are the first thing to go: they are on a later page.
		expect(text).not.toContain('read each package')
		expect(text).not.toContain('Script ·')
		expect(text).toMatch(/rows 1-6\/\d+/)
	})

	it('has every word of the full text in the short arrangement, and the details on the next page', async () => {
		const { review, summary } = summaryOf({ script: PHASED })
		const short = permissionReviewSource({
			summary,
			review,
			detailsOpen: false,
			single: true,
			columns: 100,
			pageRows: 6,
		})
		for (const line of [
			'Workflow: package-audit',
			'1. Scan — read each package and note what it exports',
			'2. Check — four independent checks, run side by side',
			'Runs in the background; you can stop it from the rail or /workflows',
			'Script · 21 lines',
		]) {
			expect(short).toContain(line)
		}
		const page2 = await showReview(100, 16, false, 6)
		expect(page2).toContain('read each package')
	})

	it('uses the ordinary text when the head fits the page', () => {
		const { review, summary } = summaryOf({ script: PHASED })
		const source = (pageRows: number) =>
			permissionReviewSource({
				summary,
				review,
				detailsOpen: false,
				single: true,
				columns: 100,
				pageRows,
			})
		expect(source(16)).not.toContain('Phase details')
		expect(source(16)).toContain('1. Scan — read each package')
		expect(source(6)).toContain('Phase details:')
	})
})

describe('the key line of a workflow review', () => {
	const keyLine = (text: string) =>
		text.split('\n').find((line) => line.includes('enter confirm')) ?? ''

	it('loses hints in order: select, stop, y / n, esc, d script, and enter last', async () => {
		const wide = keyLine(await showReview(100, 30))
		expect(wide).toContain('↑↓ select')
		expect(wide).toContain('ctrl+c stop')
		expect(wide).toContain('y / n answer')
		expect(wide).toContain('d script')
		const kept = (columns: number, line: string) => ({
			select: line.includes('↑↓ select'),
			stop: line.includes('ctrl+c stop'),
			yn: /y \/ n/.test(line),
			script: line.includes('d script'),
			esc: line.includes('esc cancel'),
			enter: line.includes('enter confirm'),
			columns,
		})
		const mid = keyLine(await showReview(60, 30))
		expect(kept(60, mid)).toMatchObject({
			select: false,
			stop: false,
			script: true,
			esc: true,
			enter: true,
		})
		// `esc cancel` goes before `d script`: Escape cancels without its hint, and
		// nothing else shows the whole script.
		const tight = keyLine(await showReview(50, 30))
		expect(kept(50, tight)).toMatchObject({ yn: false, esc: true, script: true, enter: true })
		const narrow = keyLine(await showReview(40, 30))
		expect(kept(40, narrow)).toMatchObject({
			select: false,
			stop: false,
			yn: false,
			esc: false,
			script: true,
			enter: true,
		})
	})
})
