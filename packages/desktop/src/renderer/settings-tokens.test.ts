import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Settings and the search overlay read one set of tokens from theme.css. This test fails when a token
// changes its number, when a rule stops reading its token, and when a selection control goes back to lime.

const dir = fileURLToPath(new URL('.', import.meta.url))
const read = (name: string) => readFileSync(join(dir, name), 'utf8')
const theme = read('theme.css')
const settings = read('settings-page.css')
const palette = read('command-palette.css')

const token = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(theme)?.[1]?.trim()

describe('settings and search overlay tokens', () => {
	it('holds the numbers they are measured by', () => {
		const want: Record<string, string> = {
			'--settings-search-height': '28px',
			'--settings-search-radius': '8px',
			'--settings-group-before': '40px',
			'--settings-group-after': '16px',
			'--settings-title-after': '16px',
			'--settings-row-padding': '12px',
			'--settings-control-height': '28px',
			'--settings-control-radius': '8px',
			'--settings-switch-width': '36px',
			'--settings-switch-height': '20px',
			'--settings-switch-knob': '16px',
			'--settings-switch-inset': '2px',
			'--palette-width': '672px',
			'--palette-height': '584px',
			'--palette-drop': '18px',
			'--palette-radius': '16px',
			'--palette-input-top': '18px',
			'--palette-input-height': '33px',
			'--palette-side': '24px',
			'--palette-list-inset': '10px',
			'--palette-row-height': '36px',
			'--palette-row-radius': '8px',
			'--palette-row-inset': '12px',
			'--palette-footer-height': '42px',
			'--palette-key-height': '18px',
			'--palette-key-radius': '4px',
		}
		for (const [name, value] of Object.entries(want)) expect(token(name), name).toBe(value)
		expect(token('--settings-column-width')).toBe('var(--frame-column-width)')
	})

	it('reads them in the rules', () => {
		for (const t of [
			'--settings-column-width',
			'--settings-row-padding',
			'--settings-switch-width',
			'--settings-control-height',
			'--settings-search-height',
		])
			expect(settings, t).toContain(`var(${t})`)
		for (const t of [
			'--palette-width',
			'--palette-height',
			'--palette-row-height',
			'--palette-footer-height',
			'--palette-key-height',
			'--palette-drop',
		])
			expect(palette, t).toContain(`var(${t})`)
	})

	it('draws selection controls in the text colour, not lime', () => {
		const controls = settings.slice(
			settings.indexOf('.settings-switch {'),
			settings.indexOf('.settings-choices {'),
		)
		expect(controls).not.toMatch(/var\(--primary\)|accent-color/)
		expect(settings).toMatch(/\.settings-switch:checked \{\s*background: var\(--foreground\)/)
	})

	it('shows the hints of the highlighted row only', () => {
		expect(palette).toMatch(
			/\.command-palette-meta,\s*\.command-palette-shortcut \{\s*display: none/,
		)
		expect(palette).toContain('.command-palette-item[data-highlighted] .command-palette-shortcut')
	})
})
