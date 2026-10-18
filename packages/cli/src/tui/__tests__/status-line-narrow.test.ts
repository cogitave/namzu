import { describe, expect, it } from 'vitest'
import { fitStatusLine } from '../StatusBar.js'

function line(columns: number, model = 'claude-haiku-4-5', running = true) {
	const layout = fitStatusLine({
		columns,
		provider: null,
		model,
		modeLabel: '⏵⏵ bypass permissions on',
		cycleSuffix: ' (shift+tab to cycle)',
		shells: '2 shells',
		pr: { prefix: 'PR', label: '#592' },
		effort: 'high',
		interrupt: running ? 'esc to interrupt' : null,
		agents: '← 1 agent',
		manage: '↓ to manage',
	})
	const right = layout.right.kind === 'model' ? (layout.right.model ?? '') : layout.right.text
	const left = [
		layout.mode ? `${layout.mode}${layout.cycleSuffix ?? ''}` : null,
		layout.pr ? `${layout.pr.prefix ?? ''} ${layout.pr.label}`.trim() : null,
		layout.shells,
		layout.effort,
		layout.interrupt,
		layout.agents,
		layout.manage,
	]
		.filter(Boolean)
		.join(' · ')
	return { layout, right, text: `${left}${layout.gap}${right}` }
}

describe('the footer on a narrow pane', () => {
	it('never writes more than the columns it was given', () => {
		for (const columns of [20, 30, 40, 44, 48, 56, 64, 80, 100, 140, 200]) {
			expect(line(columns).text.length, `${columns} columns`).toBeLessThanOrEqual(columns)
		}
	})

	it('shows everything when there is room', () => {
		const { layout, right } = line(200)
		expect(layout.cycleSuffix).toBe(' (shift+tab to cycle)')
		expect(layout.pr?.label).toBe('#592')
		expect(layout.effort).toBe('effort high')
		expect(layout.interrupt).toBe('esc to interrupt')
		expect(layout.agents).toBe('← 1 agent')
		expect(layout.manage).toBe('↓ to manage')
		expect(right).toBe('claude-haiku-4-5')
	})

	it('orders the items as the reference does: mode, PR, shells, then the hints', () => {
		const { text } = line(200)
		expect(text.replace(/\s+claude-haiku-4-5$/, '')).toBe(
			'⏵⏵ bypass permissions on (shift+tab to cycle) · PR #592 · 2 shells · effort high · esc to interrupt · ← 1 agent · ↓ to manage',
		)
	})

	it('drops the model first, then the hints from the right, then the rest', () => {
		let previous = line(200).layout
		const order: string[] = []
		for (let columns = 199; columns >= 24; columns--) {
			const layout = line(columns).layout
			const modelWas = previous.right.kind === 'model' && previous.right.model
			const modelIs = layout.right.kind === 'model' && layout.right.model
			if (modelWas && !modelIs) order.push('model')
			if (previous.manage && !layout.manage) order.push('manage')
			if (previous.agents && !layout.agents) order.push('agents')
			if (previous.interrupt && !layout.interrupt) order.push('interrupt')
			if (previous.cycleSuffix && !layout.cycleSuffix) order.push('cycle')
			if (previous.effort && !layout.effort) order.push('effort')
			if (previous.shells && !layout.shells) order.push('shells')
			if (previous.pr && !layout.pr) order.push('pr')
			previous = layout
		}
		expect(order.slice(0, 8)).toEqual([
			'model',
			'manage',
			'agents',
			'interrupt',
			'cycle',
			'effort',
			'shells',
			'pr',
		])
	})

	it('keeps the mode and the pull request whole while the hints are still dropping', () => {
		const { layout } = line(44)
		expect(layout.mode).toBe('⏵⏵ bypass permissions on')
		expect(layout.pr?.label).toBe('#592')
	})

	it('shows the model only while the whole row fits beside it', () => {
		const wide = line(200).layout
		expect(wide.right).toEqual({ kind: 'model', model: 'claude-haiku-4-5' })
		const full = line(200)
		const leftWidth = full.text.replace(/\s+claude-haiku-4-5$/, '').length
		const needed = leftWidth + 1 + 'claude-haiku-4-5'.length
		expect(line(needed).layout.right).toEqual({ kind: 'model', model: 'claude-haiku-4-5' })
		const justShort = line(needed - 1).layout
		expect(justShort.right).toEqual({ kind: 'model', model: null })
		expect(justShort.manage).toBe('↓ to manage')
	})
})
