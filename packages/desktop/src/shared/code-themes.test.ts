import { getSharedHighlighter } from '@pierre/diffs'
import { describe, expect, it } from 'vitest'
import { CODE_THEMES, codeThemeIds } from './code-themes.js'
import { catalogueEntry } from './settings-catalogue.js'

describe('the code colour sets', () => {
	it('keeps today’s colours as the default', () => {
		expect(codeThemeIds('default', 'default')).toMatchObject({
			light: 'pierre-light',
			dark: 'pierre-dark',
		})
	})

	it('falls back to the default for an unknown or missing choice', () => {
		expect(codeThemeIds(undefined, 'nope')).toMatchObject({
			lightKey: 'default',
			darkKey: 'default',
		})
	})

	it('is the list the two catalogue rows offer, labelled in plain words', () => {
		for (const id of ['code-theme-light', 'code-theme-dark']) {
			const control = catalogueEntry(id).control as unknown as {
				options: { value: string; label: string }[]
			}
			expect(control.options.map((option) => option.label)).toEqual([
				'Default',
				'Soft',
				'Vivid',
				'High contrast',
				'Warm',
			])
			expect(control.options.map((option) => option.value)).toEqual(CODE_THEMES.map((t) => t.value))
		}
	})

	it('names only themes the highlighter ships, so nothing is downloaded', async () => {
		const ids = CODE_THEMES.flatMap((theme) => [theme.light, theme.dark])
		const highlighter = await getSharedHighlighter({
			themes: ids as never,
			langs: ['typescript'],
			preferredHighlighter: 'shiki-js' as never,
		})
		for (const id of ids) expect(highlighter.getLoadedThemes(), id).toContain(id)
	})
})
