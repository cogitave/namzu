import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')
const dark = css.slice(css.indexOf('\n.dark {'))

function token(name: string): string {
	const match = new RegExp(`${name}: (#[0-9a-f]{6});`).exec(dark)
	if (!match?.[1]) throw new Error(`missing dark token ${name}`)
	return match[1]
}
function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((i) => {
		const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
	}) as [number, number, number]
	return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function ratio(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
	return (hi + 0.05) / (lo + 0.05)
}

describe('dark muted text contrast', () => {
	// The composer sits on --surface-raised; transcript on --background; popovers on --popover.
	const surfaces = ['--background', '--surface', '--popover', '--surface-raised', '--muted']
	for (const name of ['--muted-foreground', '--placeholder', '--icon-muted', '--secondary-label']) {
		it(`${name} reads at 4.5:1 on every dark surface`, () => {
			for (const surface of surfaces) {
				expect(ratio(token(name), token(surface))).toBeGreaterThanOrEqual(4.5)
			}
		})
	}
})
