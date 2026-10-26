import { afterEach, describe, expect, it, vi } from 'vitest'

import { PALETTES } from '../theme-palettes.js'
import {
	resetThemeStore,
	savedThemeSetting,
	setThemePreview,
	setThemeSetting,
	shownTheme,
} from '../theme-store.js'
import { DIFF_COLORS_ANSI, DIFF_COLORS_TRUECOLOR, diffColors, theme } from '../theme.js'

afterEach(() => resetThemeStore())

describe('the live theme', () => {
	it('starts as dark', () => {
		expect(shownTheme()).toBe('dark')
		expect(theme.text.muted).toBe(PALETTES.dark.text.muted)
		expect(theme.status.error).toBe('ansi256(203)')
	})

	it('changes in place, so a reader of theme.x.y sees the new colour', () => {
		setThemeSetting('light', { env: {} })
		expect(theme.text.primary).toBe(PALETTES.light.text.primary)
		expect(theme.glow).toEqual(PALETTES.light.glow)
		expect(savedThemeSetting()).toBe('light')
	})

	it('shows a preview and then goes back to the saved theme', () => {
		setThemeSetting('dark-ansi', { env: {} })
		setThemePreview('light', {})
		expect(shownTheme()).toBe('light')
		expect(savedThemeSetting()).toBe('dark-ansi')
		setThemePreview(undefined, {})
		expect(shownTheme()).toBe('dark-ansi')
		expect(theme.text.primary).toBe('whiteBright')
	})

	it('tells subscribers once per real change', async () => {
		const { createElement } = await import('react')
		const { render } = await import('ink-testing-library')
		const { Text } = await import('ink')
		const { ThemeEpochContext, useThemeSubscription } = await import('../theme-store.js')
		let draws = 0
		function Probe() {
			const epoch = useThemeSubscription()
			draws += 1
			return createElement(
				ThemeEpochContext.Provider,
				{ value: epoch },
				createElement(Text, null, `epoch ${epoch}`),
			)
		}
		const view = render(createElement(Probe))
		try {
			expect(view.lastFrame()).toContain('epoch 0')
			const before = draws
			setThemeSetting('light', { env: {} })
			setThemeSetting('light', { env: {} })
			await vi.waitFor(() => expect(view.lastFrame()).toContain('epoch 1'))
			expect(draws).toBe(before + 1)
		} finally {
			view.unmount()
		}
	})
})

describe('auto', () => {
	it('follows what the terminal reported', () => {
		setThemeSetting('auto', { reported: 'light', env: {} })
		expect(shownTheme()).toBe('light')
	})

	it('falls back to COLORFGBG and then dark', () => {
		setThemeSetting('auto', { env: { COLORFGBG: '0;15' } })
		expect(shownTheme()).toBe('light')
		resetThemeStore()
		setThemeSetting('auto', { env: {} })
		expect(shownTheme()).toBe('dark')
	})
})

describe('diff colours', () => {
	it('follow the theme and the terminal’s depth', () => {
		expect(diffColors({ COLORTERM: 'truecolor' })).toBe(DIFF_COLORS_TRUECOLOR)
		expect(diffColors({})).toBe(DIFF_COLORS_ANSI)
		setThemeSetting('light-daltonized', { env: {} })
		expect(diffColors({ COLORTERM: 'truecolor' })).toBe(PALETTES['light-daltonized'].diff.truecolor)
		expect(diffColors({})).toBe(PALETTES['light-daltonized'].diff.basic)
		setThemeSetting('dark-ansi', { env: {} })
		expect(diffColors({ COLORTERM: 'truecolor' })).toEqual(DIFF_COLORS_ANSI)
	})
})
