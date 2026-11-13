import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CONVERSATION_MIN, READING_PANEL_MIN, TOOL_PANEL_MIN } from './file-panel/file-tabs.js'

// The side panels are laid out on a few measured numbers. Each is a token in theme.css, read by the rules
// that place a panel; none is written a second time in a rule. This test pins the tokens, the code that
// repeats three of them, and the two places where a container query has to spell a sum out.

const dir = fileURLToPath(new URL('.', import.meta.url))
const read = (path: string) => readFileSync(join(dir, path), 'utf8')
const theme = read('theme.css')
const token = (name: string) =>
	theme.match(new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm'))?.[1]?.trim()

function css(root: string): string[] {
	return readdirSync(root).flatMap((name) => {
		const path = join(root, name)
		return statSync(path).isDirectory() ? css(path) : name.endsWith('.css') ? [path] : []
	})
}

describe('the panel tokens', () => {
	it('pins every panel number once, in theme.css', () => {
		const expected: Record<string, string> = {
			'--panel-reading-share': '60%',
			'--panel-reading-min': '360px',
			'--panel-tool-share': '40%',
			'--panel-tool-min': '320px',
			'--panel-tool-max': '560px',
			'--panel-conversation-min': '360px',
			'--panel-seam': '1px',
			'--panel-grab-zone': '7px',
			'--panel-grab-line': '2px',
			'--panel-header-height': '44px',
			'--panel-title-inset': '20px',
			'--panel-control-gap': '4px',
			'--panel-control-inset': '8px',
			'--panel-files-width': '240px',
			'--panel-file-row': '28px',
			'--panel-open-fill': '8%',
		}
		for (const [name, value] of Object.entries(expected)) {
			expect(token(name), name).toBe(value)
			expect(
				theme.match(new RegExp(`^\\s*${name}:`, 'gm')),
				`${name} is defined once`,
			).toHaveLength(1)
		}
		const defined = [...theme.matchAll(/^\s*(--panel-[a-z-]+):/gm)].map((m) => m[1])
		expect(defined.sort()).toEqual(
			[...Object.keys(expected), '--panel-reading-width', '--panel-tool-width'].sort(),
		)
	})

	it('makes a reading panel 60 percent, at least 360, and a tool panel 40 percent between 320 and 560', () => {
		expect(token('--panel-reading-width')).toBe(
			'max(var(--panel-reading-min), var(--panel-reading-share))',
		)
		expect(token('--panel-tool-width')).toBe(
			'clamp(var(--panel-tool-min), var(--panel-tool-share), var(--panel-tool-max))',
		)
	})

	it('repeats the floors in code exactly', () => {
		expect(`${READING_PANEL_MIN}px`).toBe(token('--panel-reading-min'))
		expect(`${TOOL_PANEL_MIN}px`).toBe(token('--panel-tool-min'))
		expect(`${CONVERSATION_MIN}px`).toBe(token('--panel-conversation-min'))
	})

	it('puts the overlay edges where the conversation would keep under its minimum', () => {
		// A reading panel is 60 percent: the conversation's 40 percent is 360 at a pane of 900.
		expect(READING_PANEL_MIN / 0.4).toBe(900)
		// A tool panel's floor is 320, so 320 and the conversation's 360 meet at 680.
		expect(TOOL_PANEL_MIN + CONVERSATION_MIN).toBe(680)
		const style = read('style.css')
		expect(style).toContain('@container workspace (max-width: 899px)')
		expect(style).toContain('@container workspace (max-width: 679px)')
		const panelCss = read('file-panel/file-panel.css')
		expect(panelCss).toContain('@container workspace (max-width: 899px)')
		expect(panelCss).toContain('@container workspace (max-width: 679px)')
	})

	it('reads the header, the files column, the row and the fill from the tokens', () => {
		const all = css(dir).map((path) => [path, readFileSync(path, 'utf8')] as const)
		const body = (file: string) => all.find(([path]) => path.endsWith(file))?.[1] ?? ''
		expect(body('style.css')).toMatch(
			/\.section-heading \{[^}]*height: var\(--panel-header-height\)/,
		)
		expect(body('review.css')).toMatch(/\.changes-bar \{[^}]*height: var\(--panel-header-height\)/)
		expect(body('review.css')).toContain('minmax(0, 1fr) var(--panel-files-width)')
		expect(body('review.css')).toMatch(/\.changes-flat-row \{[^}]*height: var\(--panel-file-row\)/)
		expect(body('conversation-bar.css')).toContain('var(--foreground) var(--panel-open-fill)')
		expect(body('file-panel.css')).toContain('width: var(--panel-grab-zone)')
		expect(body('file-panel.css')).toContain('width: var(--panel-grab-line)')
		// No rule writes a measured panel number a second time.
		for (const [path, text] of all) {
			if (!/(style|review|file-panel)\.css$/.test(path)) continue
			const rules = text.replace(/\/\*[\s\S]*?\*\//g, '')
			if (path.endsWith('review.css')) expect(rules, path).not.toMatch(/(?:width|height): 240px/)
			expect(rules, path).not.toMatch(/--panel-width: clamp\(320px/)
		}
	})
})
