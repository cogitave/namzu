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
		...Object.values(colors.code),
		...Object.values(colors.context),
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
				code: Object.keys(colors.code),
				context: Object.keys(colors.context),
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

	it('reads the context grid on white in the light themes', () => {
		for (const name of ['light', 'light-daltonized'] as const) {
			const { free, ...drawn } = PALETTES[name].context
			for (const [key, color] of Object.entries(drawn)) {
				expect(contrastOnWhite(color), `${name} ${key} ${color}`).toBeGreaterThanOrEqual(3)
			}
			expect(free).toMatch(/^ansi256\(\d+\)$/)
		}
	})

	it('gives every context category its own colour in each theme except the quiet pair', () => {
		for (const name of THEME_NAMES) {
			const c = PALETTES[name].context
			const loud = [
				c.systemPrompt,
				c.systemTools,
				c.mcpTools,
				c.mcpInstructions,
				c.agents,
				c.memory,
				c.skills,
				c.messages,
			]
			expect(new Set(loud).size, name).toBe(loud.length)
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

describe('the colours of code', () => {
	const KINDS = [
		'keyword',
		'string',
		'number',
		'comment',
		'name',
		'type',
		'literal',
		'added',
		'removed',
	] as const

	it('has a colour for every kind in every theme', () => {
		for (const name of THEME_NAMES) {
			expect(Object.keys(PALETTES[name].code).sort(), name).toEqual([...KINDS].sort())
		}
	})

	it('reads on white in the light themes', () => {
		for (const name of ['light', 'light-daltonized'] as const) {
			for (const [kind, color] of Object.entries(PALETTES[name].code)) {
				// A comment is meant to be quieter; the rest are text.
				expect(contrastOnWhite(color), `${name} ${kind} ${color}`).toBeGreaterThanOrEqual(
					kind === 'comment' ? 4 : 3.9,
				)
			}
		}
	})

	it('reads on a dark background in the dark themes', () => {
		const onDark = (color: string) => {
			const match = /^ansi256\((\d+)\)$/.exec(color)
			if (!match) throw new Error(color)
			return (luminance(ansi256Rgb(Number(match[1]))) + 0.05) / (luminance([11, 15, 12]) + 0.05)
		}
		for (const name of ['dark', 'dark-daltonized'] as const) {
			for (const [kind, color] of Object.entries(PALETTES[name].code)) {
				expect(onDark(color), `${name} ${kind} ${color}`).toBeGreaterThanOrEqual(4.5)
			}
		}
	})

	it('tells the kinds of syntax apart within a theme', () => {
		for (const name of THEME_NAMES) {
			const { added, removed, ...syntax } = PALETTES[name].code
			const values = Object.values(syntax)
			// A theme with few colours (the 16-colour ones) may not give every kind its own, but not by much.
			expect(new Set(values).size, name).toBeGreaterThanOrEqual(values.length - 1)
			expect(added, name).not.toBe(removed)
		}
	})

	it('never tells an added line from a removed one by red against green alone', () => {
		for (const name of ['dark-daltonized', 'light-daltonized'] as const) {
			const { added, removed } = PALETTES[name].code
			const rgb = (c: string) => ansi256Rgb(Number(/\((\d+)\)/.exec(c)?.[1]))
			const [ar, ag, ab] = rgb(added)
			const [rr, , rb] = rgb(removed)
			// Added is blue, removed is orange: the axis colour-blind readers keep.
			expect(ab, name).toBeGreaterThan(Math.max(ar, ag))
			expect(rr, name).toBeGreaterThan(rb)
		}
	})

	it('keeps the kinds of syntax apart under red-green colour blindness in the colour-blind themes', () => {
		// Machado et al. matrices on linear RGB, then CIE76 distance between every pair of kinds.
		const matrices = {
			protanopia: [
				[0.152286, 1.052583, -0.204868],
				[0.114503, 0.786281, 0.099216],
				[-0.003882, -0.048116, 1.051998],
			],
			deuteranopia: [
				[0.367322, 0.860646, -0.227968],
				[0.280085, 0.672501, 0.047413],
				[-0.01182, 0.04294, 0.968881],
			],
		}
		const lin = (c: number) => {
			const s = c / 255
			return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
		}
		const lab = (color: string, m: number[][]): number[] => {
			const rgb = ansi256Rgb(Number(/\((\d+)\)/.exec(color)?.[1])).map(lin) as [
				number,
				number,
				number,
			]
			const [r, g, b] = m.map((row) =>
				Math.min(
					1,
					Math.max(0, (row[0] ?? 0) * rgb[0] + (row[1] ?? 0) * rgb[1] + (row[2] ?? 0) * rgb[2]),
				),
			) as [number, number, number]
			const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
			const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.9505)
			const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b)
			const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.089)
			return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
		}
		for (const name of ['dark-daltonized', 'light-daltonized'] as const) {
			const { keyword, string, number, name: fn, type, literal } = PALETTES[name].code
			const kinds = { keyword, string, number, name: fn, type, literal }
			for (const [sim, m] of Object.entries(matrices)) {
				const entries = Object.entries(kinds)
				for (let i = 0; i < entries.length; i++) {
					for (let j = i + 1; j < entries.length; j++) {
						const a = lab((entries[i] as [string, string])[1], m)
						const b = lab((entries[j] as [string, string])[1], m)
						const distance = Math.hypot(...a.map((v, n) => v - (b[n] as number)))
						expect(
							distance,
							`${name} under ${sim}: ${(entries[i] as [string, string])[0]} / ${(entries[j] as [string, string])[0]}`,
						).toBeGreaterThanOrEqual(15)
					}
				}
			}
		}
	})

	it('uses only named colours in the 16-colour themes', () => {
		for (const name of ['dark-ansi', 'light-ansi'] as const) {
			for (const [kind, color] of Object.entries(PALETTES[name].code)) {
				expect(color, `${name} ${kind}`).toMatch(/^[a-z]+(Bright)?$/)
			}
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
