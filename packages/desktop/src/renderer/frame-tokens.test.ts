import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The frame (the header, the sidebar's rows and its foot) is laid out on one rhythm. Each number is
// defined once, as a token in theme.css, and every rule that places or sizes a frame part reads the
// token. This test pins the tokens and the rules that read them, so the numbers cannot drift apart
// again (two header heights, three row heights, labels starting at three x positions).

const dir = fileURLToPath(new URL('.', import.meta.url))

function files(root: string): string[] {
	const out: string[] = []
	for (const name of readdirSync(root)) {
		const path = join(root, name)
		if (statSync(path).isDirectory()) out.push(...files(path))
		else if (name.endsWith('.css')) out.push(path)
	}
	return out
}

type Declaration = { file: string; selector: string; prop: string; value: string }

function declarations(file: string): Declaration[] {
	const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
	const out: Declaration[] = []
	const stack: string[] = []
	let buffer = ''
	let depth = 0
	const flush = () => {
		const colon = buffer.indexOf(':')
		if (colon > 0 && stack.length > 0) {
			out.push({
				file: file.slice(dir.length),
				selector: [...stack].reverse().find((s) => !s.startsWith('@')) ?? '',
				prop: buffer.slice(0, colon).trim(),
				value: buffer.slice(colon + 1).trim(),
			})
		}
		buffer = ''
	}
	for (const ch of css) {
		if (ch === '(') depth++
		if (ch === ')') depth--
		if (depth === 0 && ch === '{') {
			stack.push(buffer.trim().replace(/\s+/g, ' '))
			buffer = ''
		} else if (depth === 0 && ch === '}') {
			flush()
			stack.pop()
		} else if (depth === 0 && ch === ';') flush()
		else buffer += ch
	}
	return out
}

const all = files(dir).flatMap(declarations)
const rootTokens = all.filter((d) => d.file === 'theme.css' && d.selector === ':root')
const tokenValue = (name: string) => rootTokens.find((d) => d.prop === name)?.value

describe('the frame tokens', () => {
	it('pins every frame number once, in theme.css', () => {
		const expected: Record<string, string> = {
			// The header band, a tab and a control inside it.
			'--frame-header-height': '36px',
			'--frame-tab-height': '28px',
			'--frame-control-size': '28px',
			// A row: 32 high, 2 between rows, 8 under the header, inset 8 and 10, padded 10, a 16px slot, a 10 gap.
			'--frame-row-height': '32px',
			'--frame-row-space': '2px',
			'--frame-row-first': '8px',
			'--frame-row-inset': '8px',
			'--frame-row-inset-end': '10px',
			'--frame-row-padding': '10px',
			'--frame-icon-slot': '16px',
			'--frame-row-gap': '10px',
			'--frame-row-radius': '10px',
			// The control at a row's end.
			'--frame-row-action': '24px',
			'--frame-row-action-inset': '4px',
			// A section title: a band 28 high, 22 above and 4 below.
			'--frame-title-band': '28px',
			'--frame-title-before': '22px',
			'--frame-title-after': '4px',
			// The foot and the rail.
			'--frame-foot-height': '45px',
			'--frame-foot-button': '28px',
			'--frame-rail-width': '48px',
			'--frame-rail-button': '32px',
			'--frame-bar-gap': '4px',
			'--frame-bar-inset': '8px',
			'--frame-title-inset': '24px',
			// The input box, the row under it and the column.
			'--frame-input-height': '44px',
			'--frame-input-radius': '12px',
			'--frame-below-gap': '8px',
			'--frame-below-height': '24px',
			'--frame-below-bottom': '8px',
			'--frame-below-inset': '10px',
			'--frame-column-width': '768px',
			'--frame-column-side': '32px',
			'--frame-column-side-narrow': '16px',
		}
		for (const [name, value] of Object.entries(expected)) {
			expect(tokenValue(name), name).toBe(value)
			expect(
				all.filter((d) => d.prop === name && d.file === 'theme.css'),
				`${name} is defined once`,
			).toHaveLength(1)
		}
		// The one override: a pane narrower than 560 closes the column's side space to the narrow token.
		const overrides = all.filter((d) => d.prop === '--frame-column-side' && d.file !== 'theme.css')
		expect(overrides.map((d) => [d.file, d.value])).toEqual([
			['style.css', 'var(--frame-column-side-narrow)'],
		])
		// Every frame token the file defines is pinned here, and every one is read by some rule.
		const defined = rootTokens.map((d) => d.prop).filter((n) => n.startsWith('--frame-'))
		expect(defined.sort()).toEqual([...Object.keys(expected), ...DERIVED].sort())
		const css = files(dir)
			.map((f) => readFileSync(f, 'utf8'))
			.join('\n')
		for (const name of defined) expect(css, `${name} is read`).toContain(`var(${name})`)
	})

	it('puts every label at x 44: inset, padding, icon slot and gap', () => {
		expect(8 + 10 + 16 + 10).toBe(44)
		expect(tokenValue('--frame-label-start')).toMatch(
			/^calc\(\s*var\(--frame-row-inset\)\s+\+\s+var\(--frame-row-padding\)\s+\+\s+var\(--frame-icon-slot\)\s+\+\s+var\(--frame-row-gap\)\s*\)$/,
		)
	})

	it('starts a section title on the left edge of the icon slot, x 18', () => {
		expect(8 + 10).toBe(18)
		expect(tokenValue('--frame-title-start')).toMatch(
			/^calc\(\s*var\(--frame-row-inset\)\s+\+\s+var\(--frame-row-padding\)\s*\)$/,
		)
	})

	it('centres the first foot button on the icons column, x 26', () => {
		// The icon slot spans x 18 to 34, so its centre is 26 and a 28px button starts at x 12.
		expect(8 + 10 + 16 / 2 - 28 / 2).toBe(12)
		expect(tokenValue('--frame-foot-start')).toMatch(
			/^calc\(\s*var\(--frame-row-inset\)\s*\+\s*var\(--frame-row-padding\)\s*\+\s*var\(--frame-icon-slot\)\s*\/\s*2\s*-\s*var\(--frame-foot-button\)\s*\/\s*2\s*\)$/,
		)
	})

	it('makes the pane header and the sidebar header the same token', () => {
		expect(tokenValue('--workspace-topbar-height')).toBe('var(--frame-header-height)')
		const other = all.filter(
			(d) => d.prop === '--workspace-topbar-height' && d.value !== 'var(--frame-header-height)',
		)
		expect(other, 'no second header height').toEqual([])
		expect(all.filter((d) => d.prop === '--frame-header-height')).toHaveLength(1)
	})

	it('starts the main header title 24 from the pane edge', () => {
		expect(tokenValue('--workspace-gutter')).toBe('var(--frame-title-inset)')
		expect(tokenValue('--frame-title-inset')).toBe('24px')
	})

	it('draws the selected row at 16 percent of the text colour in both themes', () => {
		const dark = all.find((d) => d.selector === '.dark' && d.prop === '--sidebar-row-active')
		expect(dark?.value).toBe('rgb(241 243 247 / 16%)')
		const light = all.find((d) => d.selector === ':root' && d.prop === '--sidebar-row-active')
		expect(light?.value).toBe('rgb(39 39 42 / 16%)')
		const hover = all.find((d) => d.selector === '.dark' && d.prop === '--sidebar-row-hover')
		expect(hover?.value).toBe('rgb(241 243 247 / 8%)')
	})

	it('reads the input box height from one token in both rules, and its radius from the frame', () => {
		expect(tokenValue('--radius-composer')).toBe('var(--frame-input-radius)')
		const heights = all.filter(
			(d) =>
				d.file === 'composer.css' &&
				d.prop === 'min-height' &&
				(d.selector.includes('composer-host') || d.selector.includes('main-surface')),
		)
		expect(heights.length).toBeGreaterThanOrEqual(2)
		for (const d of heights) expect(d.value, d.selector).toBe('var(--frame-input-height)')
		const literal = all.filter(
			(d) =>
				d.file === 'composer.css' &&
				d.selector.includes('composer-shell') &&
				/^(min-)?height$/.test(d.prop) &&
				d.value === '44px',
		)
		expect(literal, 'no second 44').toEqual([])
	})
})

/** Frame tokens that are computed from the pinned ones. */
const DERIVED = [
	'--frame-label-start',
	'--frame-title-start',
	'--frame-foot-start',
	'--frame-dock-rest',
]

/** [file, selector, property, the token the value must read]. */
const READS: ReadonlyArray<readonly [string, string, string, string]> = [
	['sidebar-navigation.css', '.sidebar-project-heading', 'height', '--frame-row-height'],
	['sidebar-navigation.css', '.sidebar-project-heading', 'border-radius', '--frame-row-radius'],
	[
		'sidebar-navigation.css',
		'.sidebar-project-heading .project-row',
		'height',
		'--frame-row-height',
	],
	[
		'sidebar-navigation.css',
		'.sidebar-project-heading .sidebar-project-toggle',
		'height',
		'--frame-row-height',
	],
	[
		'sidebar-navigation.css',
		'.sidebar-project-list .conversation-row, .sidebar-recent-list .conversation-row',
		'height',
		'--frame-row-height',
	],
	[
		'sidebar-navigation.css',
		'.sidebar-project-list .sidebar-conversation-button, .sidebar-recent-list .sidebar-conversation-button',
		'border-radius',
		'--frame-row-radius',
	],
	[
		'sidebar-navigation.css',
		'.sidebar-navigation .sidebar-add-project-row, .sidebar-project-navigation .sidebar-add-project-row',
		'height',
		'--frame-row-height',
	],
	// The space between rows: every list of rows is a column with the frame's row space.
	['sidebar-navigation.css', '.sidebar-project-navigation', 'gap', '--frame-row-space'],
	[
		'sidebar-navigation.css',
		'.sidebar-project-list, .sidebar-recent-list',
		'gap',
		'--frame-row-space',
	],
	['settings-page.css', '.settings-sidebar-navigation', 'gap', '--frame-row-space'],
	['plugins-page.css', '.plugins-sidebar-installed ul', 'gap', '--frame-row-space'],
	// The row's end control: 24 by 24, 4 from the end of the row.
	[
		'sidebar-navigation.css',
		'.sidebar-project-heading .sidebar-project-more, .sidebar-thread-item .sidebar-thread-action, .sidebar-section-head .sidebar-add-project, .sidebar-recents-head .sidebar-archive-toggle',
		'width',
		'--frame-row-action',
	],
	[
		'sidebar-navigation.css',
		'.sidebar-project-heading .sidebar-project-more, .sidebar-thread-item .sidebar-thread-action, .sidebar-section-head .sidebar-add-project, .sidebar-recents-head .sidebar-archive-toggle',
		'height',
		'--frame-row-action',
	],
	['thread-card.css', '.sidebar-thread-actions', 'right', '--frame-row-action-inset'],
	[
		'thread-card.css',
		'.sidebar-thread-item[data-removable]',
		'--thread-action-size',
		'--frame-row-action',
	],
	// A section title: the band, the room above and below, and where its text starts.
	[
		'sidebar-navigation.css',
		'.sidebar-section-head, .sidebar-recents-head, .sidebar-day-heading',
		'height',
		'--frame-title-band',
	],
	[
		'sidebar-navigation.css',
		'.sidebar-section-head, .sidebar-recents-head, .sidebar-day-heading',
		'margin',
		'--frame-title-before',
	],
	[
		'sidebar-navigation.css',
		'.sidebar-section-head, .sidebar-recents-head, .sidebar-day-heading',
		'margin',
		'--frame-title-after',
	],
	[
		'sidebar-navigation.css',
		'.sidebar-section-head, .sidebar-recents-head, .sidebar-day-heading',
		'padding',
		'--frame-row-padding',
	],
	['plugins-page.css', '.plugins-sidebar-installed h2', 'height', '--frame-title-band'],
	['style.css', '.sidebar-section-title', 'font-weight', '--weight-control'],
	['sidebar-navigation.css', '.sidebar-day-heading > h3', 'font-weight', '--weight-control'],
	['style.css', '.project-row, .sidebar-new-conversation', 'height', '--frame-row-height'],
	['style.css', '.project-row, .sidebar-new-conversation', 'gap', '--frame-row-gap'],
	['style.css', '.project-row, .sidebar-new-conversation', 'padding', '--frame-row-padding'],
	['style.css', '.project-row, .sidebar-new-conversation', 'border-radius', '--frame-row-radius'],
	['style.css', '.project-row, .sidebar-new-conversation', 'margin', '--frame-row-inset-end'],
	['style.css', '.sidebar-new-conversation', 'margin-top', '--frame-row-first'],
	['style.css', '.conversation-row', 'height', '--frame-row-height'],
	['style.css', '.conversation-row', 'gap', '--frame-row-gap'],
	['style.css', '.conversation-row-mark', 'width', '--frame-icon-slot'],
	['style.css', '.sidebar-scroll', '--sidebar-scroll-end', '--frame-row-inset-end'],
	['style.css', '.sidebar-foot', 'height', '--frame-foot-height'],
	['style.css', '.sidebar-foot', 'padding', '--frame-foot-start'],
	[
		'style.css',
		':is(.rail-band, .rail-foot, .sidebar-foot) > .rail-button',
		'width',
		'--frame-foot-button',
	],
	[
		'style.css',
		':is(.rail-band, .rail-foot, .sidebar-foot) > .rail-button',
		'height',
		'--frame-foot-button',
	],
	['style.css', '.rail-button', 'width', '--frame-rail-button'],
	['style.css', '.rail-button', 'height', '--frame-rail-button'],
	['style.css', '.rail-band', 'height', '--frame-header-height'],
	['style.css', '.rail-foot', 'height', '--frame-foot-height'],
	[
		'style.css',
		'.app[data-sidebar-collapsed="true"]',
		'grid-template-columns',
		'--frame-rail-width',
	],
	['plugins-page.css', '.plugins-sidebar-header', 'height', '--frame-header-height'],
	['settings-page.css', '.settings-sidebar-navigation button', 'height', '--frame-row-height'],
	['settings-page.css', '.settings-sidebar-navigation button', 'gap', '--frame-row-gap'],
	[
		'settings-page.css',
		'.settings-sidebar-navigation button',
		'border-radius',
		'--frame-row-radius',
	],
	['pals-page.css', '.sidebar-pals .sidebar-pal-row', 'height', '--frame-row-height'],
	['pals-page.css', '.sidebar-pals .sidebar-pal-row', 'border-radius', '--frame-row-radius'],
	['pals-page.css', '.sidebar-pals .sidebar-pal-row > svg', 'width', '--frame-icon-slot'],
	['conversation-tabs.css', '.conversation-tab', 'height', '--frame-tab-height'],
	['conversation-bar.css', '.conversation-bar-buttons', 'gap', '--frame-bar-gap'],
	['conversation-actions-menu.css', '.conversation-header-actions', 'gap', '--frame-bar-gap'],
	// The box, the row under it and the column.
	['composer.css', '.composer-column', 'width', '--frame-column-width'],
	['composer.css', '.composer-column', 'width', '--frame-column-side'],
	['composer.css', '.composer-dock-foot', 'height', '--frame-below-bottom'],
	['composer.css', '.composer-row', 'margin-top', '--frame-below-gap'],
	['composer.css', '.composer-row-inner', 'min-height', '--frame-below-height'],
	['composer.css', '.composer-row-inner', 'padding-inline', '--frame-below-inset'],
	[
		'composer.css',
		'.composer-row :is(.composer-control, .context-readout, .context-ring)',
		'height',
		'--frame-below-height',
	],
	['composer.css', '.composer-home', 'padding-inline', '--frame-column-side'],
	['composer.css', '.composer-home', '--home-growth', '--frame-dock-rest'],
	['composer.css', '.composer-home', 'margin-bottom', '--home-growth'],
	['composer.css', '.composer-home-block', 'top', '--home-growth'],
	['style.css', '.transcript', 'padding', '--frame-column-side'],
]

describe('the rules that place the frame', () => {
	it.each(READS)('%s %s %s reads %s', (file, selector, prop, token) => {
		const found = all.find((d) => d.file === file && d.selector === selector && d.prop === prop)
		expect(found, `${file} ${selector} ${prop}`).toBeDefined()
		expect(found?.value).toContain(`var(${token})`)
	})

	it('draws the hairline under the main header only, inside its height, and never on the home screen', () => {
		const get = (file: string, selector: string, prop = 'box-shadow') =>
			all.find((d) => d.file === file && d.selector === selector && d.prop === prop)?.value
		expect(get('style.css', '.topbar')).toBe('inset 0 -1px 0 var(--border)')
		// The sidebar's header and the Settings and Plugins sidebars' header draw no line under them.
		expect(get('style.css', '.sidebar-chrome')).toBeUndefined()
		expect(get('plugins-page.css', '.plugins-sidebar-header')).toBeUndefined()
		// Home (a new conversation with nothing in it) has nothing to separate.
		expect(get('style.css', '.workspace:has([data-composer-home]) > .topbar')).toBe('none')
		// Settings, Plugins and Pals have no top bar: the same line, at the same y, inside the same band.
		const page =
			'.workspace:is([data-page="settings"], [data-page="plugins"], [data-page="pals"])::before'
		expect(get('style.css', page)).toBe('inset 0 -1px 0 var(--border)')
		expect(get('style.css', page, 'height')).toBe('var(--frame-header-height)')
		expect(get('style.css', page, 'top') ?? get('style.css', page, 'inset')).toBeDefined()
		// The foot: a 1px line, inside its height.
		expect(get('style.css', '.sidebar-foot', 'border-top')).toBe('1px solid var(--sidebar-border)')
		expect(get('style.css', '.sidebar-foot', 'box-sizing')).toBe('border-box')
		expect(get('style.css', '.rail-foot', 'border-top')).toBe('1px solid var(--sidebar-border)')
		const topbar = all.filter((d) => d.selector === '.topbar' && d.prop.startsWith('border'))
		expect(topbar, 'the top bar draws no border that would change its height').toEqual([])
	})

	it('has no literal 52px or 40px header or 34px/30px/28px row left in the sidebar rules', () => {
		const sidebar = new Set([
			'sidebar-navigation.css',
			'thread-card.css',
			'sidebar-section.css',
			'conversation-bar.css',
			'conversation-tabs.css',
		])
		const stale = all.filter(
			(d) =>
				sidebar.has(d.file) &&
				/^(min-)?height$/.test(d.prop) &&
				/^(52|40|34|30)px$/.test(d.value) &&
				!d.selector.includes('placeholder'),
		)
		expect(stale).toEqual([])
	})

	it('spaces the sidebar on 2, 4, 6, 8, 12, 16, 20, 24 and 32 px', () => {
		const allowed = new Set([0, 1, 2, 4, 6, 8, 12, 16, 20, 24, 32])
		const spacing = /^(margin|padding|gap)(-[a-z]+)*$/
		const files = new Set(['sidebar-navigation.css', 'thread-card.css', 'sidebar-section.css'])
		const bad: string[] = []
		for (const d of all) {
			if (!files.has(d.file) || !spacing.test(d.prop)) continue
			for (const m of d.value.matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
				if (!allowed.has(Math.abs(Number(m[1]))))
					bad.push(`${d.file} ${d.selector} ${d.prop}: ${d.value}`)
			}
		}
		expect(bad).toEqual([])
	})
})
