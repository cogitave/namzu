import { describe, expect, it, vi } from 'vitest'
import { codePrefsOf, getCodePrefs, setCodePrefs, subscribeCodePrefs } from './code-prefs.js'

describe('the code colour choices code views draw with', () => {
	it('maps the saved choices to the highlighter themes, the default for none', () => {
		expect(codePrefsOf({})).toEqual({ light: 'pierre-light', dark: 'pierre-dark' })
		expect(codePrefsOf({ lightCodeTheme: 'contrast', darkCodeTheme: 'warm' })).toEqual({
			light: 'github-light-high-contrast',
			dark: 'gruvbox-dark-medium',
		})
	})

	it('changes what a view reads and tells every listener, also when only the font changed', () => {
		const listener = vi.fn()
		const stop = subscribeCodePrefs(listener)
		setCodePrefs({ lightCodeTheme: 'soft', darkCodeTheme: 'vivid' })
		expect(getCodePrefs()).toEqual({ light: 'pierre-light-soft', dark: 'pierre-dark-vibrant' })
		setCodePrefs({ lightCodeTheme: 'soft', darkCodeTheme: 'vivid' })
		expect(listener).toHaveBeenCalledTimes(2)
		stop()
		setCodePrefs({ lightCodeTheme: 'default', darkCodeTheme: 'default' })
		expect(listener).toHaveBeenCalledTimes(2)
		expect(getCodePrefs().light).toBe('pierre-light')
	})
})
