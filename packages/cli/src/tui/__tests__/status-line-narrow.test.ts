import { describe, expect, it } from 'vitest'
import { fitStatusLine } from '../StatusBar.js'

function line(columns: number, model = 'claude-haiku-4-5') {
	const layout = fitStatusLine({
		columns,
		provider: null,
		model,
		modeLabel: '⏵⏵ bypass permissions on',
		cycleSuffix: ' (shift+tab to cycle)',
		shells: '2 shells',
		shellsHint: '/jobs to manage',
		pr: { prefix: 'PR', label: '#592' },
		effort: 'high',
	})
	const right = layout.right.kind === 'model' ? (layout.right.model ?? '') : layout.right.text
	const left = [
		layout.mode ? `${layout.mode}${layout.cycleSuffix ?? ''}` : null,
		layout.interrupt,
		layout.shells ? `${layout.shells}${layout.shellsHint ? ` ${layout.shellsHint}` : ''}` : null,
		layout.pr ? `${layout.pr.prefix ?? ''} ${layout.pr.label}`.trim() : null,
		layout.effort,
	]
		.filter(Boolean)
		.join(' · ')
	return { layout, right, text: `${left}${layout.gap}${right}` }
}

describe('the footer on a narrow pane', () => {
	it('never writes more than the columns it was given', () => {
		for (const columns of [20, 30, 40, 44, 48, 56, 64, 80, 100, 140]) {
			expect(line(columns).text.length, `${columns} columns`).toBeLessThanOrEqual(columns)
		}
	})

	it('shows everything when there is room', () => {
		const { layout } = line(140)
		expect(layout.shellsHint).toBe('/jobs to manage')
		expect(layout.cycleSuffix).toBe(' (shift+tab to cycle)')
		expect(layout.pr?.label).toBe('#592')
		expect(layout.effort).toBe('effort high')
	})

	it('drops the shells hint, then the cycle hint, then the effort, then the PR item, in that order', () => {
		let previous = line(140).layout
		const order: string[] = []
		for (let columns = 139; columns >= 24; columns--) {
			const layout = line(columns).layout
			if (previous.shellsHint && !layout.shellsHint) order.push('shellsHint')
			if (previous.cycleSuffix && !layout.cycleSuffix) order.push('cycle')
			if (previous.effort && !layout.effort) order.push('effort')
			if (previous.pr && !layout.pr) order.push('pr')
			if (
				previous.right.kind === 'model' &&
				previous.right.model &&
				layout.right.kind === 'model' &&
				!layout.right.model
			) {
				order.push('model')
			}
			previous = layout
		}
		expect(order.slice(0, 5)).toEqual(['shellsHint', 'cycle', 'effort', 'pr', 'model'])
	})

	it('keeps the mode and the shell pill whole while anything else is still dropping', () => {
		const { layout } = line(44)
		expect(layout.mode).toBe('⏵⏵ bypass permissions on')
		expect(layout.shells).toBe('2 shells')
	})
})
