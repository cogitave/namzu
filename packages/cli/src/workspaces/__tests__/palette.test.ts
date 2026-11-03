import { describe, expect, it } from 'vitest'
import { DEFAULT_COLOR, RGB_FLAG, rgb } from '../../terminal/host/cell.js'
import { PALETTES } from '../../tui/theme-palettes.js'
import { THEME_NAMES } from '../../tui/theme-palettes.js'
import {
	advertisesTruecolor,
	colorLevel,
	nearestAnsi,
	paletteFor,
	resolveColor,
} from '../palette.js'

const of = (name: (typeof THEME_NAMES)[number], level: Parameters<typeof paletteFor>[0]) =>
	paletteFor(level, { theme: PALETTES[name], name })

describe('resolving a theme colour', () => {
	it('uses an ansi256 token as that palette entry, in colour or not', () => {
		expect(resolveColor('ansi256(83)', 'truecolor')).toBe(83)
		expect(resolveColor('ansi256(83)', '256')).toBe(83)
	})

	it('turns an ansi256 token into the nearest of the 16 colours where only those are shown', () => {
		const value = resolveColor('ansi256(203)', '16')
		expect(value).toBeGreaterThanOrEqual(0)
		expect(value).toBeLessThan(16)
		expect(resolveColor('ansi256(0)', '16')).toBe(0)
		expect(resolveColor('ansi256(15)', '16')).toBe(15)
	})

	it('reads the named colours as the 16', () => {
		expect(resolveColor('black', '256')).toBe(0)
		expect(resolveColor('redBright', '16')).toBe(9)
		expect(resolveColor('blackBright', 'truecolor')).toBe(8)
		expect(resolveColor('whiteBright', 'truecolor')).toBe(15)
	})

	it('writes a hex token as true colour, the nearest 256 entry or the nearest of the 16', () => {
		expect(resolveColor('#0b0f0c', 'truecolor')).toBe(rgb(11, 15, 12))
		const mid = resolveColor('#0b0f0c', '256')
		expect(mid).toBeGreaterThanOrEqual(16)
		expect(mid & RGB_FLAG).toBe(0)
		expect(resolveColor('#0b0f0c', '16')).toBe(0)
		expect(resolveColor('#ffffff', '16')).toBe(15)
		expect(resolveColor('rgb(255,0,0)', 'truecolor')).toBe(rgb(255, 0, 0))
	})

	it('has no colour at all when asked for none', () => {
		expect(resolveColor('ansi256(83)', 'none')).toBe(DEFAULT_COLOR)
		expect(resolveColor('#ffffff', 'none')).toBe(DEFAULT_COLOR)
	})

	it('finds the nearest of the 16', () => {
		expect(nearestAnsi([0, 0, 0])).toBe(0)
		expect(nearestAnsi([255, 255, 255])).toBe(15)
		expect(nearestAnsi([250, 10, 10])).toBe(9)
	})
})

describe('the palette', () => {
	it('is the main theme: its accent, borders, text and statuses', () => {
		const dark = of('dark', 'truecolor')
		expect(dark.accent).toBe(83)
		expect(dark.focus).toBe(83)
		expect(dark.border).toBe(239)
		expect(dark.text).toBe(252)
		expect(dark.subtext).toBe(248)
		expect(dark.dim).toBe(245)
		expect(dark.working).toBe(221)
		expect(dark.blocked).toBe(203)
		expect(dark.ahead).toBe(77)
		expect(dark.behind).toBe(203)
		expect(dark.done).toBe(37)
		expect(dark.branch).toBe(109)
		expect(dark.navigate).toBe(117)
		expect(dark.resize).toBe(141)
		expect(dark.ink).toBe(rgb(11, 15, 12))
	})

	it('leaves the bar and the modals on the terminal background', () => {
		for (const name of THEME_NAMES) expect(of(name, 'truecolor').base).toBe(DEFAULT_COLOR)
	})

	it('follows the theme: the light one draws darker hues and white ink on its accent', () => {
		const light = of('light', 'truecolor')
		expect(light.accent).toBe(28)
		expect(light.ink).toBe(rgb(255, 255, 255))
		expect(light.activeRow).toBe(255)
		expect(light.cursorRow).toBe(253)
		const daltonized = of('dark-daltonized', 'truecolor')
		expect(daltonized.accent).not.toBe(of('dark', 'truecolor').accent)
	})

	it('uses only the 16 named colours for the ansi themes', () => {
		for (const name of ['dark-ansi', 'light-ansi'] as const) {
			const palette = of(name, '256')
			for (const [role, value] of Object.entries(palette)) {
				if (typeof value !== 'number' || role === 'base') continue
				expect(value, role).toBeLessThan(16)
			}
		}
	})

	it('falls back to the 16 colours with both tints on bright black, so the shown row still stands out', () => {
		for (const name of THEME_NAMES) {
			const palette = of(name, '16')
			for (const [role, value] of Object.entries(palette)) {
				if (typeof value !== 'number') continue
				if (role === 'base') expect(value).toBe(DEFAULT_COLOR)
				else expect(value & RGB_FLAG, `${name} ${role}`).toBe(0)
				if (role !== 'base') expect(value, `${name} ${role}`).toBeLessThan(16)
			}
			expect(palette.activeRow).toBe(8)
			expect(palette.cursorRow).toBe(8)
		}
	})

	it('draws no colour and says so with no colour', () => {
		const none = of('dark', 'none')
		expect(none.mono).toBe(true)
		for (const [role, value] of Object.entries(none)) {
			if (typeof value === 'number') expect(value, role).toBe(DEFAULT_COLOR)
		}
		expect(of('dark', 'truecolor').mono).toBe(false)
	})

	it('keeps a warning apart from plain text in every theme', () => {
		for (const name of THEME_NAMES) {
			for (const level of ['truecolor', '256', '16'] as const) {
				const palette = of(name, level)
				expect(palette.warn, `${name} ${level}`).not.toBe(palette.text)
				expect(palette.blocked, `${name} ${level}`).not.toBe(palette.idle)
			}
		}
	})
})

describe('how much colour there is', () => {
	it('is what the main TUI says about true colour', () => {
		expect(advertisesTruecolor({ COLORTERM: 'truecolor' })).toBe(true)
		expect(advertisesTruecolor({ COLORTERM: '24BIT' })).toBe(true)
		expect(advertisesTruecolor({ WT_SESSION: 'x' })).toBe(true)
		expect(advertisesTruecolor({ TERM_PROGRAM: 'iTerm.app' })).toBe(true)
		expect(advertisesTruecolor({ COLORTERM: 'yes' })).toBe(false)
		expect(advertisesTruecolor({})).toBe(false)
	})

	it('picks a level from the environment', () => {
		expect(colorLevel({ COLORTERM: 'truecolor' })).toBe('truecolor')
		expect(colorLevel({ WT_SESSION: 'x' })).toBe('truecolor')
		expect(colorLevel({ TERM: 'xterm-256color' })).toBe('256')
		expect(colorLevel({ TERM: 'xterm' })).toBe('16')
		expect(colorLevel({})).toBe('16')
	})

	it('is none under NO_COLOR, FORCE_COLOR=0 or a dumb terminal, even when true colour is advertised', () => {
		expect(colorLevel({ NO_COLOR: '1', COLORTERM: 'truecolor' })).toBe('none')
		expect(colorLevel({ FORCE_COLOR: '0', COLORTERM: 'truecolor' })).toBe('none')
		expect(colorLevel({ TERM: 'dumb' })).toBe('none')
		expect(colorLevel({ NO_COLOR: '', COLORTERM: 'truecolor' })).toBe('truecolor')
	})
})
