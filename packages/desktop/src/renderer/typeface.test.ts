import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SETTINGS_ENTRIES } from './settings-model.js'

// The shipped typefaces: three variable files loaded from the app's own folder, with the platform
// stacks kept behind them, and the licence travelling with the files.

const desktop = fileURLToPath(new URL('../../', import.meta.url))
const theme = readFileSync(join(desktop, 'src/renderer/theme.css'), 'utf8').replace(
	/\/\*[\s\S]*?\*\//g,
	'',
)
const html = readFileSync(join(desktop, 'index.html'), 'utf8')

function token(name: string): string {
	const found = new RegExp(`${name}:\\s*([^;]+);`).exec(theme)
	if (!found) throw new Error(`${name} is not defined in theme.css`)
	return (found[1] as string).replace(/\s+/g, ' ').trim()
}

const faces = [...theme.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1] as string)

describe('the @font-face rules', () => {
	it('declare the sans, its italic and the mono as variable weight ranges, and the display face as one static weight', () => {
		const summary = faces.map((body) => ({
			family: /font-family:\s*"([^"]+)"/.exec(body)?.[1],
			style: /font-style:\s*(\w+)/.exec(body)?.[1],
			weight: /font-weight:\s*([\d ]+);/.exec(body)?.[1]?.trim(),
			display: /font-display:\s*(\w+)/.exec(body)?.[1],
		}))
		expect(summary).toEqual([
			{ family: 'Geist', style: 'normal', weight: '100 900', display: 'block' },
			{ family: 'Geist', style: 'italic', weight: '100 900', display: 'block' },
			{ family: 'Geist Mono', style: 'normal', weight: '100 900', display: 'block' },
			{ family: 'Geist Pixel', style: 'normal', weight: '400', display: 'block' },
		])
	})

	it('name files that exist, and the licence sits beside them', () => {
		for (const body of faces) {
			const url = /url\("\/fonts\/([^"]+)"\)/.exec(body)?.[1]
			expect(url, body).toBeTruthy()
			const file = join(desktop, 'public/fonts', url as string)
			expect(existsSync(file), file).toBe(true)
			// A woff2 file starts with its signature.
			expect(readFileSync(file).subarray(0, 4).toString('latin1')).toBe('wOF2')
			// The display face is the smallest file (pixel outlines); the three variable files are larger.
			expect(statSync(file).size).toBeGreaterThan(20_000)
		}
		const licence = readFileSync(join(desktop, 'public/fonts/OFL.txt'), 'utf8')
		expect(licence).toContain('Copyright 2026 The Geist Project Authors')
		// The display face carries its own copyright line inside the file; it travels with it.
		expect(licence).toContain('Copyright 2026 The Geist Pixel Project Authors')
		expect(licence).toContain('SIL OPEN FONT LICENSE Version 1.1')
		expect(readFileSync(join(desktop, 'licenses/fonts-geist-OFL.txt'), 'utf8')).toBe(licence)
	})

	it('are started loading by index.html before the bundle runs, and the policy needs no change', () => {
		// A preload link does not match the font request on file: addresses (the browser warns and
		// fetches twice), so three hidden letters in the three faces do the early request instead.
		expect(html).not.toMatch(/rel="preload"/)
		const prime = /<div aria-hidden="true"[^>]*>(.*?)<\/div>/.exec(html)?.[1] ?? ''
		expect(prime).toContain('<span>a</span>')
		expect(prime).toContain('<span style="font-style:italic">a</span>')
		expect(prime).toContain('<span style="font-family:var(--font-mono)">a</span>')
		expect(prime).toContain('<span style="font-family:var(--font-display)">a</span>')
		expect(html.indexOf('aria-hidden="true"')).toBeLessThan(html.indexOf('id="root"'))
		const policy = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? ''
		expect(policy).toContain("default-src 'self'")
		expect(policy).not.toMatch(/font-src/)
	})

	it('are listed in the notices the build keeps and in the notices file', () => {
		const script = readFileSync(join(desktop, 'scripts/retain-notices.mjs'), 'utf8')
		expect(script).toContain('licenses/fonts-geist-OFL.txt')
		const notices = readFileSync(join(desktop, 'THIRD-PARTY-NOTICES.txt'), 'utf8')
		expect(notices).toContain('Geist, Geist Mono and Geist Pixel (Square)')
		expect(notices).toContain('Geist Pixel')
		expect(notices).toContain('fonts/GeistPixel-Square.woff2')
		expect(notices).toContain('Copyright 2026 The Geist Project Authors')
	})
})

describe('the font stacks', () => {
	const sansPlatform = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
	const monoPlatform =
		'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

	it('start with the shipped face and end with today’s platform stack', () => {
		expect(token('--font-sans-system')).toBe(sansPlatform)
		expect(token('--font-mono-system')).toBe(monoPlatform)
		expect(token('--font-sans-app')).toBe('"Geist", var(--font-sans-system)')
		expect(token('--font-mono-app')).toBe('"Geist Mono", var(--font-mono-system)')
		expect(token('--font-sans')).toBe('var(--font-sans-app)')
		expect(token('--font-mono')).toBe('var(--font-mono-app)')
	})

	it('give the display face the interface face as its fallback', () => {
		expect(token('--font-display-app')).toBe('"Geist Pixel", var(--font-sans-app)')
		expect(token('--font-display')).toBe('var(--font-display-app)')
	})

	it('switch to the platform stacks alone when the interface font is the system’s', () => {
		const rule = /:root\[data-interface-font="system"\]\s*{([^}]*)}/.exec(theme)?.[1] ?? ''
		// The display token goes with them: no pixel letter is drawn with the device's fonts.
		expect(rule.replace(/\s+/g, ' ').trim()).toBe(
			'--font-sans: var(--font-sans-system); --font-mono: var(--font-mono-system); --font-display: var(--font-sans-system);',
		)
		expect(rule).not.toMatch(/Geist/)
	})

	it('leave the terminal on the shipped mono whatever the interface font is', () => {
		expect(token('--font-terminal')).toBe('var(--font-mono-app)')
	})

	it('keep the three weights the scale defines', () => {
		expect(token('--weight-text')).toBe('400')
		expect(token('--weight-control')).toBe('500')
		expect(token('--weight-strong')).toBe('600')
	})
})

describe('the setting', () => {
	it('is found by its name and by the word font, in the appearance section', () => {
		const entry = SETTINGS_ENTRIES.find((e) => e.id === 'interface-font')
		expect(entry?.section).toBe('appearance')
		expect(entry?.label).toBe('Interface font')
		expect(entry?.keywords).toContain('font')
	})

	it('is read before the first paint', () => {
		const boot = readFileSync(join(desktop, 'public/theme-boot.js'), 'utf8')
		expect(boot).toContain("'namzu.interface-font'")
		expect(boot).toContain('data-interface-font')
	})
})
