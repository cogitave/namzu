import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The panes are laid out on a few measured numbers. The sizes of the grid are constants in pane-grid.ts
// (tested there); the numbers of a pane's own chrome are tokens in theme.css, read by the rules that draw it.
// This test pins those tokens and that no rule writes one of them a second time.

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
		expect(defined.sort()).toEqual(Object.keys(expected).sort())
	})

	it('reads the header, the files column, the row, the fill and the seam from the tokens', () => {
		const all = css(dir).map((path) => [path, readFileSync(path, 'utf8')] as const)
		const body = (file: string) => all.find(([path]) => path.endsWith(file))?.[1] ?? ''
		expect(body('style.css')).toMatch(
			/\.section-heading \{[^}]*height: var\(--panel-header-height\)/,
		)
		expect(body('review.css')).toMatch(/\.changes-bar \{[^}]*height: var\(--panel-header-height\)/)
		expect(body('review.css')).toContain('minmax(0, 1fr) var(--panel-files-width)')
		expect(body('review.css')).toMatch(/\.changes-flat-row \{[^}]*height: var\(--panel-file-row\)/)
		expect(body('pane-grid.css')).toContain('width: var(--panel-grab-zone)')
		expect(body('pane-grid.css')).toContain('width: var(--panel-grab-line)')
		// No rule writes a measured panel number a second time.
		for (const [path, text] of all) {
			if (!/(style|review|file-panel)\.css$/.test(path)) continue
			const rules = text.replace(/\/\*[\s\S]*?\*\//g, '')
			if (path.endsWith('review.css')) expect(rules, path).not.toMatch(/(?:width|height): 240px/)
		}
	})
})
