import { describe, expect, it } from 'vitest'

import {
	PALETTES,
	type SemanticColors,
	THEME_CHOICES,
	THEME_NAMES,
	parseThemeSetting,
	resolveTheme,
	themeLabel,
} from '../theme-palettes.js'

/** An `ansi256(n)` index as RGB, by the standard 256-colour table. */
function ansi256Rgb(index: number): [number, number, number] {
	if (index < 16) throw new Error(`system colour ${index} has no fixed rgb`)
	if (index >= 232) {
		const level = 8 + (index - 232) * 10
		return [level, level, level]
	}
	const cube = [0, 95, 135, 175, 215, 255]
	const n = index - 16
	return [cube[Math.floor(n / 36)] ?? 0, cube[Math.floor(n / 6) % 6] ?? 0, cube[n % 6] ?? 0]
}

function luminance([r, g, b]: [number, number, number]): number {
	const lin = (c: number) => {
		const s = c / 255
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
	}
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast of an `ansi256(n)` foreground on white. */
function contrastOnWhite(color: string): number {
	const match = /^ansi256\((\d+)\)$/.exec(color)
	if (!match) throw new Error(`not an ansi256 colour: ${color}`)
	return 1.05 / (luminance(ansi256Rgb(Number(match[1]))) + 0.05)
}

function strings(colors: SemanticColors): string[] {
	return [
		colors.background,
		...Object.values(colors.text),
		...Object.values(colors.accent),
		...Object.values(colors.status),
		...Object.values(colors.border),
		colors.live.done,
		colors.live.edge,
		colors.live.ahead,
		...colors.glow,
		...Object.values(colors.diff.truecolor),
		...Object.values(colors.diff.basic),
	]
}

describe('palettes', () => {
	it('lists the six themes and a row for each plus auto, in the picker order', () => {
		expect(THEME_NAMES).toEqual([
			'dark',
			'light',
			'dark-daltonized',
			'light-daltonized',
			'dark-ansi',
			'light-ansi',
		])
		expect(THEME_CHOICES.map((choice) => choice.label)).toEqual([
			'Auto (match terminal)',
			'Dark mode',
			'Light mode',
			'Dark mode (colorblind-friendly)',
			'Light mode (colorblind-friendly)',
			'Dark mode (ANSI colors only)',
			'Light mode (ANSI colors only)',
		])
		expect(THEME_CHOICES.map((choice) => choice.value)).toEqual(['auto', ...THEME_NAMES])
	})

	it('defines every token in every theme', () => {
		const shape = (colors: SemanticColors) => JSON.stringify(Object.keys(colors).sort())
		const groups = (colors: SemanticColors) =>
			JSON.stringify({
				text: Object.keys(colors.text),
				accent: Object.keys(colors.accent),
				status: Object.keys(colors.status),
				border: Object.keys(colors.border),
				diff: Object.keys(colors.diff.truecolor),
			})
		for (const name of THEME_NAMES) {
			expect(shape(PALETTES[name]), name).toBe(shape(PALETTES.dark))
			expect(groups(PALETTES[name]), name).toBe(groups(PALETTES.dark))
			for (const value of strings(PALETTES[name])) {
				expect(value, name).toMatch(/\S/)
			}
		}
	})

	it('keeps the dark theme as it always was', () => {
		expect(PALETTES.dark.text).toEqual({
			primary: 'ansi256(252)',
			secondary: 'ansi256(248)',
			muted: 'ansi256(245)',
		})
		expect(PALETTES.dark.accent.assistant).toBe('ansi256(83)')
		expect(PALETTES.dark.status).toEqual({
			ok: 'ansi256(77)',
			warn: 'ansi256(221)',
			error: 'ansi256(203)',
			merged: 'ansi256(135)',
		})
		expect(PALETTES.dark.border).toEqual({ default: 'ansi256(239)', focus: 'ansi256(83)' })
		expect(PALETTES.dark.glow).toEqual(['ansi256(183)', 'ansi256(141)', 'ansi256(97)'])
		expect(PALETTES.dark.diff.truecolor.added).toBe('rgb(34,92,43)')
		expect(PALETTES.dark.diff.basic.addedWord).toBe('greenBright')
	})

	it('reads on white in the light themes', () => {
		for (const name of ['light', 'light-daltonized'] as const) {
			const { text, status, accent } = PALETTES[name]
			for (const color of [text.primary, text.secondary, text.muted]) {
				expect(contrastOnWhite(color), `${name} ${color}`).toBeGreaterThanOrEqual(4.5)
			}
			for (const color of [status.ok, status.error, status.warn, accent.assistant, accent.system]) {
				expect(contrastOnWhite(color), `${name} ${color}`).toBeGreaterThanOrEqual(3)
			}
		}
	})

	it('draws nothing white on white in the light themes', () => {
		for (const name of ['light', 'light-daltonized', 'light-ansi'] as const) {
			const colors = PALETTES[name]
			for (const value of [colors.live.edge, colors.text.primary, colors.text.muted]) {
				expect(value, name).not.toMatch(/white|ansi256\((15|231|255)\)/i)
			}
		}
	})

	it('uses only the terminal’s named colours in the ANSI themes', () => {
		for (const name of ['dark-ansi', 'light-ansi'] as const) {
			for (const value of strings(PALETTES[name])) {
				expect(value, `${name} ${value}`).toMatch(/^[a-z]+(Bright)?$/)
			}
			expect(PALETTES[name].live.rgb).toBeUndefined()
		}
	})

	it('moves success and added off green in the colorblind-friendly themes', () => {
		for (const name of ['dark-daltonized', 'light-daltonized'] as const) {
			const colors = PALETTES[name]
			expect(colors.status.ok).not.toBe(PALETTES.dark.status.ok)
			expect(colors.diff.truecolor.added).toMatch(/^rgb\(\d+,\d+,\d+\)$/)
			const [r, , b] = (colors.diff.truecolor.added.match(/\d+/g) ?? []).map(Number)
			expect(b ?? 0).toBeGreaterThan(r ?? 255)
			expect(colors.diff.basic.added).toBe('blue')
		}
	})
})

describe('resolving a setting', () => {
	it('follows the detected background for auto', () => {
		expect(resolveTheme('auto', 'light')).toBe('light')
		expect(resolveTheme('auto', 'dark')).toBe('dark')
	})

	it('is dark for auto with nothing detected and for a name that is not a theme', () => {
		expect(resolveTheme('auto', undefined)).toBe('dark')
		expect(resolveTheme('solarized', 'light')).toBe('dark')
		expect(resolveTheme(undefined, 'light')).toBe('dark')
	})

	it('keeps a named theme whatever was detected', () => {
		expect(resolveTheme('dark-ansi', 'light')).toBe('dark-ansi')
		expect(resolveTheme('light', 'dark')).toBe('light')
	})

	it('parses only exact names and labels them for people', () => {
		expect(parseThemeSetting('light-daltonized')).toBe('light-daltonized')
		expect(parseThemeSetting('Light')).toBeUndefined()
		expect(themeLabel('dark-ansi')).toBe('Dark mode (ANSI colors only)')
		expect(themeLabel('auto')).toBe('Auto (match terminal)')
	})
})
