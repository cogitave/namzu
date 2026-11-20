import { describe, expect, it } from 'vitest'
import { fitStatusLine, vimLabel } from '../StatusBar.js'

function row(columns: number, vim: string | null, extra: { hint?: string; model?: string } = {}) {
	const layout = fitStatusLine({
		columns,
		vim,
		provider: null,
		model: extra.model ?? 'claude-haiku-4-5',
		...(extra.hint ? { hint: extra.hint } : {}),
		modeLabel: '⏵⏵ accept edits on',
		cycleSuffix: ' (shift+tab to cycle)',
		shells: '2 shells',
		pr: { prefix: 'PR', label: '#592' },
		effort: 'high',
		interrupt: 'esc to interrupt',
		agents: '← 1 agent',
		manage: '↓ to manage',
	})
	const right = layout.right.kind === 'model' ? (layout.right.model ?? '') : layout.right.text
	const left = [
		layout.vim ?? null,
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
	return { layout, text: `${left}${layout.gap}${right}` }
}

describe('the footer names the vim mode', () => {
	it('words the three modes the way a vim user reads them', () => {
		expect(vimLabel('INSERT')).toBe('-- INSERT --')
		expect(vimLabel('VISUAL')).toBe('-- VISUAL --')
		expect(vimLabel('VISUAL LINE')).toBe('-- VISUAL LINE --')
	})

	it('puts the mode first on the row', () => {
		const { text, layout } = row(120, vimLabel('INSERT'))
		expect(layout.vim).toBe('-- INSERT --')
		expect(text.startsWith('-- INSERT -- · ')).toBe(true)
	})

	it('never writes more than the columns, at any width, in any mode', () => {
		for (const mode of ['INSERT', 'VISUAL', 'VISUAL LINE'] as const) {
			for (let columns = 0; columns <= 200; columns += 1) {
				const { text } = row(columns, vimLabel(mode))
				expect(text.length, `${mode} at ${columns} columns`).toBeLessThanOrEqual(columns)
			}
		}
	})

	it('keeps the mode at 80 columns, with every other item that fits', () => {
		const { layout, text } = row(79, vimLabel('VISUAL LINE'))
		expect(layout.vim).toBe('-- VISUAL LINE --')
		expect(text.length).toBeLessThanOrEqual(79)
	})

	it('drops the other items before the mode', () => {
		const { layout } = row(30, vimLabel('INSERT'))
		expect(layout.vim).toBe('-- INSERT --')
		expect(layout.manage).toBeNull()
	})

	it('a row too narrow for the words says nothing of the mode rather than cutting it', () => {
		const { layout } = row(10, vimLabel('VISUAL LINE'))
		expect(layout.vim).toBeUndefined()
	})

	it('leaves room for the mode when a hint holds the right end', () => {
		const { layout, text } = row(60, vimLabel('INSERT'), {
			hint: 'esc to cancel · enter to confirm · tab to switch',
		})
		expect(layout.vim).toBe('-- INSERT --')
		expect(text.length).toBeLessThanOrEqual(60)
	})

	it('without a mode the row is what it was', () => {
		const withNone = row(100, null).layout
		expect(withNone.vim).toBeUndefined()
		expect('vim' in withNone).toBe(false)
	})
})
