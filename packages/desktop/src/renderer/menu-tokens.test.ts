import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MENU_OFFSET } from './menu-metrics.js'

// Every menu, list popover, select and dialog reads one set of tokens from theme.css. This test fails
// when a token is missing or changes its number, when a menu rule stops reading its token, and when a
// positioner puts a number of its own where MENU_OFFSET belongs.

const dir = fileURLToPath(new URL('.', import.meta.url))
const read = (name: string) => readFileSync(join(dir, name), 'utf8')
const theme = read('theme.css')
const menu = read('menu.css')
const dialog = read('dialog.css')

function token(name: string): string | undefined {
	return new RegExp(`${name}:\\s*([^;]+);`).exec(theme)?.[1]?.trim()
}

/** The declarations of the first rule whose selector list contains `selector`. */
function rule(css: string, selector: string): string {
	const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
	for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const selectors = (match[1] ?? '').split(',').map((part) => part.trim())
		if (selectors.includes(selector)) return match[2] ?? ''
	}
	throw new Error(`no rule for ${selector}`)
}

function walk(root: string, ext: RegExp): string[] {
	const out: string[] = []
	for (const name of readdirSync(root)) {
		const path = join(root, name)
		if (statSync(path).isDirectory()) out.push(...walk(path, ext))
		else if (ext.test(name) && !name.endsWith('.test.ts')) out.push(path)
	}
	return out
}

describe('menu tokens', () => {
	it('holds the numbers every menu is measured by', () => {
		const want: Record<string, string> = {
			'--menu-radius': '12px',
			'--menu-padding': '5px',
			'--menu-row-height': '28px',
			'--menu-row-height-described': '46px',
			'--menu-row-radius': '8px',
			'--menu-text-inset': '10px',
			'--menu-icon-size': '16px',
			'--menu-icon-gap': '12px',
			'--menu-check-inset': '9px',
			'--menu-caption-block': '25px',
			'--menu-separator-space': '4px',
			'--menu-separator-inset': '10px',
			'--menu-min-width': '128px',
			'--menu-max-width': '320px',
		}
		for (const [name, value] of Object.entries(want)) expect(token(name), name).toBe(value)
		// The label of a row with an icon starts 10 + 16 + 12 = 38 in.
		expect(token('--menu-label-start')).toContain('var(--menu-text-inset)')
		expect(token('--menu-highlight')).toContain('var(--foreground) 8%')
		expect(MENU_OFFSET).toBe(6)
	})

	it('holds the numbers every dialog is measured by', () => {
		expect(token('--dialog-padding')).toBe('16px')
		expect(token('--dialog-radius')).toBe('12px')
		expect(token('--dialog-confirm-width')).toBe('400px')
		expect(token('--dialog-gap')).toBe('8px')
		expect(token('--dialog-actions-gap')).toBe('16px')
		expect(token('--dialog-button-height')).toBe('28px')
		expect(token('--dialog-button-radius')).toBe('8px')
		expect(token('--dialog-scrim')).toContain('black 40%')
		expect(/\.dark\s*\{[^}]*--dialog-scrim:[^;]*black 50%/.test(theme)).toBe(true)
	})

	it('has the menu rules read the tokens, with no number of their own', () => {
		const popup = rule(menu, '.conversation-actions-popup')
		expect(popup).toContain('padding: var(--menu-padding)')
		expect(popup).toContain('border-radius: var(--menu-radius)')
		expect(popup).toContain('var(--menu-min-width)')
		expect(popup).toContain('var(--menu-max-width)')
		const item = rule(menu, '.conversation-actions-item')
		expect(item).toContain('min-height: var(--menu-row-height)')
		expect(item).toContain('border-radius: var(--menu-row-radius)')
		expect(item).toContain('var(--menu-text-inset)')
		expect(item).toContain('gap: var(--menu-icon-gap)')
		expect(rule(menu, '.conversation-actions-item[data-highlighted]')).toContain(
			'background: var(--menu-highlight)',
		)
		expect(rule(menu, '.conversation-actions-separator')).toContain('var(--menu-separator-space)')
		expect(rule(menu, '.conversation-actions-separator')).toContain('var(--menu-separator-inset)')
		expect(rule(menu, '.menu-caption')).toContain('height: var(--menu-caption-block)')
		expect(rule(menu, '.menu-check')).toContain('inset-inline-end: var(--menu-check-inset)')
	})

	it('has every menu family read the shared rules or the tokens', () => {
		for (const selector of [
			'.plugin-actions-menu',
			'.computer-workspace-menu',
			'.menu-popup',
			'.plugin-actions-menu-item',
			'.computer-workspace-menu-item',
			'.menu-item',
		])
			expect(menu, selector).toContain(selector)
		const reads: Record<string, string[]> = {
			'composer-settings.css': [
				'--menu-padding',
				'--menu-row-height-described',
				'--menu-highlight',
				'--menu-check-inset',
			],
			'model-picker.css': [
				'--menu-radius',
				'--menu-padding',
				'--menu-row-height',
				'--menu-row-height-described',
				'--menu-highlight',
				'--menu-check-inset',
				'--menu-caption-block',
			],
			'harness-picker.css': [
				'--menu-padding',
				'--menu-row-height',
				'--menu-highlight',
				'--menu-check-inset',
			],
			'composer-effort-panel.css': ['--menu-padding'],
			'conversation-details-popover.css': [
				'--menu-radius',
				'--menu-padding',
				'--menu-row-height',
				'--menu-highlight',
			],
			'composer.css': ['--menu-radius', '--menu-padding', '--menu-highlight', '--menu-check-inset'],
		}
		for (const [file, tokens] of Object.entries(reads))
			for (const name of tokens)
				expect(read(file), `${file} reads ${name}`).toContain(`var(${name})`)
		// A select and the popover that holds a list read the same surface.
		expect(read('ui/select.tsx')).toContain('rounded-(--menu-radius)')
		expect(read('ui/select.tsx')).toContain('p-(--menu-padding)')
		expect(read('ui/select.tsx')).toContain('menu-check')
		expect(read('ui/popover.tsx')).toContain('rounded-(--menu-radius)')
	})

	it('has no menu rule outside menu.css draw the surface or a row of its own', () => {
		// The classes below were once styled one by one; their rules live in menu.css only.
		for (const file of walk(dir, /\.css$/)) {
			if (file.endsWith('menu.css')) continue
			const css = read(file.slice(dir.length)).replace(/\/\*[\s\S]*?\*\//g, '')
			for (const selector of [
				'.conversation-actions-popup',
				'.conversation-actions-item',
				'.plugin-actions-menu',
				'.plugin-actions-menu-item',
				'.computer-workspace-menu',
				'.computer-workspace-menu-item',
				'.rail-menu',
			]) {
				// A rule written for the same class on a narrower selector (the side panel's wider add menu) is allowed
				// to change the width only.
				const own = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) =>
					(m[1] ?? '').split(',').some((part) => part.trim() === selector),
				)
				expect(own.length, `${file} styles ${selector}`).toBe(0)
			}
		}
	})

	it('has every positioner sit MENU_OFFSET from its control', () => {
		// Files whose menus another piece of work owns keep their own number until it lands: the strip at
		// the top of the window and the approval card's menu.
		const others = new Set(['window-titlebar.tsx', 'composer-approval.tsx'])
		const offenders: string[] = []
		for (const file of walk(dir, /\.tsx$/)) {
			const name = file.slice(dir.length)
			if (others.has(name)) continue
			const lines = readFileSync(file, 'utf8').split('\n')
			for (const [index, line] of lines.entries()) {
				const literal = /sideOffset=\{(\d+)\}|sideOffset = (\d+)/.exec(line)
				if (!literal) continue
				// A context menu opens at the pointer, which is not a control; a hover card is not a menu.
				const nearby = lines.slice(Math.max(0, index - 6), index + 1).join(' ')
				if (/ContextMenu|PreviewCard|TooltipPopup|tooltip/.test(nearby) || /actionTip/.test(line))
					continue
				if (Number(literal[1] ?? literal[2]) !== MENU_OFFSET) offenders.push(`${name}:${index + 1}`)
			}
		}
		expect(offenders).toEqual([])
	})

	it('has every dialog class read the dialog tokens', () => {
		expect(rule(dialog, '.dialog-popup')).toContain('padding: var(--dialog-padding)')
		expect(rule(dialog, '.dialog-popup')).toContain('border-radius: var(--dialog-radius)')
		expect(rule(dialog, '.dialog-popup[data-dialog-size="confirm"]')).toContain(
			'var(--dialog-confirm-width)',
		)
		expect(rule(dialog, '.dialog-scrim')).toContain('background: var(--dialog-scrim)')
		expect(rule(dialog, '.dialog-actions')).toContain('var(--dialog-actions-gap)')
		expect(rule(dialog, '.dialog-actions > button')).toContain(
			'height: var(--dialog-button-height)',
		)
		for (const file of [
			'update-dialog.css',
			'pal-communication-dialog.css',
			'pals-page.css',
			'attachment-list.css',
		])
			expect(read(file), file).toContain('var(--dialog-scrim)')
	})
})
