import { describe, expect, it } from 'vitest'
import { terminalFontFamily, terminalTheme } from './terminal-theme.js'

const tokens: Record<string, string> = {
	'--background': '#101012',
	'--foreground': '#eeeeee',
	'--primary': '#3ddc84',
}
const read = (name: string) => tokens[name] ?? ''

describe('terminalTheme', () => {
	it('takes the app background, text and accent', () => {
		const theme = terminalTheme(read, true)
		expect(theme).toMatchObject({
			background: '#101012',
			foreground: '#eeeeee',
			cursor: '#3ddc84',
			cursorAccent: '#101012',
		})
	})

	it('has sixteen colours in each appearance and they differ between them', () => {
		const dark = terminalTheme(read, true)
		const light = terminalTheme(read, false)
		const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const
		for (const theme of [dark, light])
			for (const name of names) {
				expect(theme[name]).toMatch(/^#[0-9a-f]{6}$/)
				const bright = `bright${name[0]?.toUpperCase()}${name.slice(1)}` as keyof typeof theme
				expect(theme[bright]).toMatch(/^#[0-9a-f]{6}$/)
			}
		expect(dark.red).not.toBe(light.red)
	})

	it('falls back when a token is missing', () => {
		expect(terminalTheme(() => '', false).background).toBe('#ffffff')
		expect(terminalTheme(() => '', true).background).toBe('#09090b')
		expect(terminalFontFamily(() => '')).toContain('monospace')
		expect(terminalFontFamily(() => 'Fira Code, monospace')).toBe('Fira Code, monospace')
	})
})

function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((index) => {
		const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
	}) as [number, number, number]
	return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a: string, b: string): number {
	const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
	return (high + 0.05) / (low + 0.05)
}

describe('terminalTheme legibility', () => {
	const tokens2: Record<string, string> = { '--background': '#181818', '--foreground': '#f5f5f5' }
	it('keeps selected text readable, reverse video included', () => {
		const dark = terminalTheme((name) => tokens2[name] ?? '', true)
		expect(
			contrast(dark.selectionBackground as string, dark.selectionForeground as string),
		).toBeGreaterThan(4.5)
		const light = terminalTheme(() => '', false)
		expect(
			contrast(light.selectionBackground as string, light.selectionForeground as string),
		).toBeGreaterThan(4.5)
	})
	it('keeps dark black and bright black visible on the dark background', () => {
		const dark = terminalTheme((name) => tokens2[name] ?? '', true)
		expect(contrast(dark.black as string, '#181818')).toBeGreaterThan(2.5)
		expect(contrast(dark.brightBlack as string, '#181818')).toBeGreaterThan(4.5)
	})
})
