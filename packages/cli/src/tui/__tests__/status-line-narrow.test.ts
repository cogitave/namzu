import { describe, expect, it } from 'vitest'
import { fitStatusLine, shortenPathToFit } from '../StatusBar.js'

const WINDOWS_CWD = String.raw`C:\Users\Arda\Documents\Namzu\New project 3`

function line(columns: number, cwd = WINDOWS_CWD, model = 'claude-haiku-4-5') {
	const layout = fitStatusLine({
		columns,
		cwd,
		provider: null,
		model,
		modeLabel: 'shift+tab to cycle',
	})
	const right = layout.right.kind === 'model' ? (layout.right.model ?? '') : layout.right.text
	const left = [layout.mode, layout.cwd].filter(Boolean).join(' · ')
	return { layout, right, text: `${left}${layout.gap}${right}` }
}

describe('the footer on a narrow pane', () => {
	it('never writes more than the columns it was given, and keeps the model from 44 columns up', () => {
		for (const columns of [44, 48, 56, 64, 80, 100]) {
			const { text, right } = line(columns)
			expect(text.length, `${columns} columns`).toBeLessThanOrEqual(columns)
			expect(right, `${columns} columns`).toBe('claude-haiku-4-5')
		}
	})

	it('shortens a Windows path from the left and starts at a folder, not mid-name', () => {
		const shortened = shortenPathToFit(WINDOWS_CWD, 30)
		expect(shortened.length).toBeLessThanOrEqual(30)
		expect(shortened.startsWith('…')).toBe(true)
		expect(shortened).toMatch(/^…\\/)
		expect(shortened.endsWith('New project 3')).toBe(true)
	})

	it('still shortens a POSIX path at a slash', () => {
		expect(shortenPathToFit('/home/arda/work/namzu/packages/cli', 22)).toBe('…/namzu/packages/cli')
	})
})
