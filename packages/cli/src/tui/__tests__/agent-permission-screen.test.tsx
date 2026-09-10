/** Agent approval should explain the work and keep every decision on screen. */

import { expect, it } from 'vitest'

import { PermissionOverlay } from '../PermissionOverlay.js'
import {
	buildPermissionReview,
	buildPermissionSummary,
	permissionReviewPageRows,
	permissionReviewRows,
} from '../permission-review.js'
import { renderToScreen } from './support/screen.js'

it('shows the default capability before approving one apparently read-only task', async () => {
	const toolCalls = [
		{
			id: 'agent-one',
			name: 'Agent',
			input: { description: 'Read package files', prompt: 'Only inspect src/index.ts.' },
			isDestructive: false,
		},
	]
	const review = buildPermissionReview(toolCalls)
	if (!review.ok) throw new Error('fixture must fit the exact approval envelope')
	const screen = await renderToScreen(
		<PermissionOverlay
			toolCalls={toolCalls}
			review={review.text}
			summary={buildPermissionSummary(review.text)}
			detailsOpen={false}
			columns={100}
			rows={24}
		/>,
		{ cols: 100, rows: 24 },
	)
	try {
		await screen.waitForRender()
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('1. Read package files · files + commands')
		expect(visible).not.toContain('Agent: general-purpose (default)')
		expect(visible).toContain('d full instructions')
		expect(visible).not.toContain('Instructions: Only inspect src/index.ts.')
		expect(visible).toContain('❯ 1. Start this agent')
		expect(visible).toContain('2. Start and allow all tools for this session')
		expect(visible).toContain('3. Do not start')
		expect(visible).not.toContain('read-only tools')
	} finally {
		await screen.unmount()
	}
})

it.each([60, 100])('keeps a ten-agent review and its exact input reachable at %i columns', async (cols) => {
	const toolCalls = Array.from({ length: 10 }, (_, index) => ({
		id: `agent-${index + 1}`,
		name: 'Agent',
		input: {
			description: `Inspect package ${index + 1}`,
			subagent_type: index % 2 === 0 ? 'explore' : 'general-purpose',
			prompt: `Read package ${index + 1}. Report evidence and the complete final finding ${index + 1}.`,
		},
		isDestructive: false,
	}))
	const review = buildPermissionReview(toolCalls)
	if (!review.ok) throw new Error('fixture must fit the exact approval envelope')
	const summary = buildPermissionSummary(review.text)
	const props = { toolCalls, review: review.text, summary, columns: cols, rows: 24 }
	const screen = await renderToScreen(<PermissionOverlay {...props} detailsOpen={false} />, {
		cols,
		rows: 24,
	})
	try {
		await screen.waitForRender()
		const initial = screen.viewport().join('\n')
		expect(initial).toContain('Start 10 agents')
		expect(initial).toContain('1. Inspect package 1')
		expect(initial).toContain('read-only')
		expect(initial).toContain('files + commands')
		expect(initial).toContain('❯ 1. Start these 10 agents')
		expect(initial).toContain('2. Start and allow all tools for this session')
		expect(initial).toContain('3. Do not start')
		expect(initial).toContain('PgUp/PgDn')
		expect(initial).toContain('ctrl+c decline and stop the turn')
		expect(initial).not.toContain('"calls"')

		const collected: string[] = []
		const pageRows = permissionReviewPageRows(24)
		const bodyRows = permissionReviewRows(summary.compactText ?? summary.text, cols)
		for (let offset = 0; offset < bodyRows.length; offset += pageRows) {
			screen.rerender(<PermissionOverlay {...props} detailsOpen={false} reviewOffset={offset} />)
			await screen.waitForRender()
			const visible = screen.viewport().join('\n')
			collected.push(visible)
			expect(visible).toContain('3. Do not start')
			expect(visible).toContain('ctrl+c decline and stop the turn')
		}
		for (let index = 1; index <= 10; index += 1) {
			expect(collected.join('\n')).toContain(`Inspect package ${index}`)
			expect(collected.join('\n')).not.toContain(`final finding ${index}.`)
		}

		screen.rerender(<PermissionOverlay {...props} detailsOpen />)
		await screen.waitForRender()
		const exact = screen.viewport().join('\n')
		expect(exact).toContain('Exact prepared input')
		expect(exact).toContain('"calls"')
		expect(exact).toContain('"id": "agent-1"')
		expect(exact).toContain('3. Do not start')
		const exactPages: string[] = []
		for (let offset = 0; offset < permissionReviewRows(review.text, cols).length; offset += pageRows) {
			screen.rerender(<PermissionOverlay {...props} detailsOpen reviewOffset={offset} />)
			await screen.waitForRender()
			exactPages.push(screen.viewport().join('\n'))
		}
		// Physical wrapping can split a word; all original argument rows must remain reachable.
		const exactRows = permissionReviewRows(review.text, cols)
		for (const row of exactRows) {
			if (row.text.trim()) expect(exactPages.join('\n')).toContain(row.text)
		}

	} finally {
		await screen.unmount()
	}
})


it('shows only actual workflow labels and keeps two long prompts compact on a 24-row screen', async () => {
	const toolCalls = ['CLI startup', 'SDK memory'].map((description, index) => ({
		id: `agent-${index}`, name: 'Agent', isDestructive: false,
		input: { description, prompt: 'Long private task detail. '.repeat(60), subagent_type: 'explore', workflow: 'Repository review', phase: 'Inspect', phase_order: 0 },
	}))
	const review = buildPermissionReview(toolCalls)
	if (!review.ok) throw new Error('fixture must fit')
	const summary = buildPermissionSummary(review.text)
	const screen = await renderToScreen(<PermissionOverlay toolCalls={toolCalls} review={review.text} summary={summary} detailsOpen={false} columns={100} rows={24} />, { cols: 100, rows: 24 })
	try {
		await screen.waitForRender()
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('Repository review / Inspect')
		expect(visible).toContain('[ 1. CLI startup · read-only ]')
		expect(visible).toContain('[ 2. SDK memory · read-only ]')
		expect(visible).not.toContain('Phase display order')
		expect(visible).not.toContain('Long private task detail')
		expect(visible).not.toContain('Synthesize')
		expect(visible).not.toContain('PgUp/PgDn')
		expect(visible).toContain('3. Do not start')
		expect(review.text).toContain('Long private task detail')
	} finally { await screen.unmount() }
})
