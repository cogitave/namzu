import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SidebarFoot } from './navigation-rail.js'

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
const theme = read('./theme.css')
const style = read('./style.css')
const host = read('./workspace-host.css')

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
	const start = css.indexOf(`\n${selector} {`)
	if (start < 0) throw new Error(`missing rule ${selector}`)
	return css.slice(start, css.indexOf('}', start))
}
function block(name: 'light' | 'dark'): string {
	const open = name === 'dark' ? '\n.dark {' : '\n:root {\n\tcolor-scheme: light;'
	const start = theme.indexOf(open)
	return theme.slice(start, theme.indexOf('\n}', start))
}
function token(css: string, name: string): string {
	const match = new RegExp(`${name}: (#[0-9a-f]{6});`).exec(css)
	if (!match?.[1]) throw new Error(`missing token ${name}`)
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

describe('the frame is two flat regions', () => {
	it('has no rounded corner and no shadow on the sidebar, the rail or the conversation', () => {
		expect(style).not.toContain('--content-corner-radius')
		expect(host).not.toContain('--content-corner-radius')
		for (const selector of ['.sidebar', '.navigation-rail', '.workspace', '.sidebar-foot']) {
			const declarations = rule(style, selector)
			expect(declarations, selector).not.toMatch(/border-radius|box-shadow/)
		}
		expect(rule(host, '.workspace-stage')).not.toMatch(/border-radius|box-shadow/)
	})

	it('divides the regions by one hairline, on the sidebar and on the rail that stands for it', () => {
		expect(rule(style, '.sidebar')).toContain('border-right: 1px solid var(--sidebar-border)')
		expect(rule(style, '.navigation-rail')).toContain(
			'border-right: 1px solid var(--sidebar-border)',
		)
	})

	it('fills the frame with at most two steps: the sidebar side and the conversation', () => {
		for (const name of ['light', 'dark'] as const) {
			expect(block(name), name).toContain('--chrome: var(--sidebar);')
		}
		expect(rule(style, '.navigation-rail')).toContain('background: var(--sidebar)')
		expect(rule(style, '.workspace')).toContain('background: var(--background)')
		expect(rule(style, '.window-titlebar')).toContain('background: var(--chrome)')
	})

	it('keeps text on the sidebar side readable in both themes', () => {
		for (const name of ['light', 'dark'] as const) {
			const css = block(name)
			for (const text of ['--sidebar-foreground', '--sidebar-muted-foreground']) {
				expect(
					ratio(token(css, text), token(css, '--sidebar')),
					`${name} ${text}`,
				).toBeGreaterThanOrEqual(4.5)
			}
		}
	})

	it('draws the rail only where the sidebar is collapsed: no column for it while it is open', () => {
		expect(rule(style, '.app')).toContain('grid-template-columns: 0 288px minmax(0, 1fr)')
		expect(rule(style, '.app[data-sidebar-collapsed="true"]')).toContain(
			'grid-template-columns: 48px 0 minmax(0, 1fr)',
		)
	})

	it('ends the sidebar header and the top bar on one line', () => {
		// One height, with or without the strip of tabs: the token is defined once (theme.css).
		expect(theme).toContain('--frame-header-height: 44px')
		expect(theme).toContain('--workspace-topbar-height: var(--frame-header-height)')
		expect(style).not.toContain('--frame-header-height: ')
		expect(host).not.toContain('--workspace-topbar-height: ')
	})
})

describe('the foot of the sidebar', () => {
	const foot = (props: Partial<Parameters<typeof SidebarFoot>[0]> = {}) =>
		renderToStaticMarkup(
			createElement(SidebarFoot, { section: 'home', onSettings: () => {}, ...props }),
		)
	const labels = (markup: string) =>
		[...markup.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1])

	it('is the Main navigation landmark with Settings in it, as the rail was', () => {
		const markup = foot()
		expect(markup).toContain('aria-label="Main navigation"')
		expect(labels(markup)).toEqual(['Main navigation', 'Settings'])
	})

	it('offers no second Home where the sidebar has a New conversation row', () => {
		expect(labels(foot())).not.toContain('Home')
	})

	it('carries Home where the sidebar has no such row, before Settings', () => {
		expect(labels(foot({ onHome: () => {} }))).toEqual(['Main navigation', 'Home', 'Settings'])
	})

	it('marks Settings as the current page while Settings is open', () => {
		expect(foot({ section: 'settings' })).toMatch(/aria-label="Settings"[^>]*aria-current="page"/)
	})

	it('shows the update button with its name, after Settings, and a place for the announcement', () => {
		const markup = foot({
			update: {
				state: { status: 'ready', version: '2.0.0' },
				onOpen: () => {},
				onCheck: () => {},
			},
		})
		expect(labels(markup)).toEqual([
			'Main navigation',
			'Settings',
			'Update ready. Restart Namzu to install version 2.0.0',
		])
		expect(markup).toContain('aria-live="polite"')
	})

	it('shows no update button when there is nothing to install', () => {
		const markup = foot({
			update: { state: { status: 'idle' }, onOpen: () => {}, onCheck: () => {} },
		})
		expect(markup).not.toContain('rail-update-button')
	})
})
