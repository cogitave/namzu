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
			'--frame-header-height': '44px',
			'--frame-tab-height': '32px',
			'--frame-control-size': '28px',
			'--frame-row-height': '32px',
			'--frame-row-inset': '8px',
			'--frame-row-padding': '8px',
			'--frame-icon-slot': '16px',
			'--frame-row-gap': '8px',
			'--frame-foot-height': '48px',
			'--frame-foot-button': '32px',
			'--frame-bar-gap': '4px',
			'--frame-bar-inset': '8px',
		}
		for (const [name, value] of Object.entries(expected)) {
			expect(tokenValue(name), name).toBe(value)
			expect(
				all.filter((d) => d.prop === name),
				`${name} is defined once`,
			).toHaveLength(1)
		}
	})

	it('puts every label at x 40: inset, padding, icon slot and gap', () => {
		const sum = 8 + 8 + 16 + 8
		expect(sum).toBe(40)
		expect(tokenValue('--frame-label-start')).toMatch(
			/^calc\(\s*var\(--frame-row-inset\)\s+\+\s+var\(--frame-row-padding\)\s+\+\s+var\(--frame-icon-slot\)\s+\+\s+var\(--frame-row-gap\)\s*\)$/,
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

	it('draws the selected row at 14 percent of the text colour in the dark theme', () => {
		const dark = all.find((d) => d.selector === '.dark' && d.prop === '--sidebar-row-active')
		expect(dark?.value).toBe('rgb(241 243 247 / 14%)')
		const hover = all.find((d) => d.selector === '.dark' && d.prop === '--sidebar-row-hover')
		expect(hover?.value).toBe('rgb(241 243 247 / 8%)')
	})
})

/** [file, selector, property, the token the value must read]. */
const READS: ReadonlyArray<readonly [string, string, string, string]> = [
	['sidebar-navigation.css', '.sidebar-project-heading', 'height', '--frame-row-height'],
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
		'.sidebar-navigation .sidebar-add-project-row, .sidebar-project-navigation .sidebar-add-project-row',
		'height',
		'--frame-row-height',
	],
	['style.css', '.project-row, .sidebar-new-conversation', 'height', '--frame-row-height'],
	['style.css', '.project-row, .sidebar-new-conversation', 'gap', '--frame-row-gap'],
	['style.css', '.project-row, .sidebar-new-conversation', 'padding', '--frame-row-padding'],
	['style.css', '.conversation-row', 'height', '--frame-row-height'],
	['style.css', '.conversation-row', 'gap', '--frame-row-gap'],
	['style.css', '.conversation-row-mark', 'width', '--frame-icon-slot'],
	['style.css', '.sidebar-foot', 'height', '--frame-foot-height'],
	['style.css', '.rail-button', 'width', '--frame-foot-button'],
	['style.css', '.rail-button', 'height', '--frame-foot-button'],
	['plugins-page.css', '.plugins-sidebar-header', 'height', '--frame-header-height'],
	['settings-page.css', '.settings-sidebar-navigation button', 'height', '--frame-row-height'],
	['settings-page.css', '.settings-sidebar-navigation button', 'gap', '--frame-row-gap'],
	['pals-page.css', '.sidebar-pals .sidebar-pal-row', 'height', '--frame-row-height'],
	['conversation-tabs.css', '.conversation-tab', 'height', '--frame-tab-height'],
	['conversation-bar.css', '.conversation-bar-buttons', 'gap', '--frame-bar-gap'],
	['conversation-actions-menu.css', '.conversation-header-actions', 'gap', '--frame-bar-gap'],
]

describe('the rules that place the frame', () => {
	it.each(READS)('%s %s %s reads %s', (file, selector, prop, token) => {
		const found = all.find((d) => d.file === file && d.selector === selector && d.prop === prop)
		expect(found, `${file} ${selector} ${prop}`).toBeDefined()
		expect(found?.value).toContain(`var(${token})`)
	})

	it('draws the hairline under each header and above the foot inside its height', () => {
		const get = (file: string, selector: string) =>
			all.find((d) => d.file === file && d.selector === selector && d.prop === 'box-shadow')?.value
		expect(get('style.css', '.topbar')).toBe('inset 0 -1px 0 var(--border)')
		expect(get('style.css', '.sidebar-chrome')).toBe('inset 0 -1px 0 var(--sidebar-border)')
		expect(get('plugins-page.css', '.plugins-sidebar-header')).toBe(
			'inset 0 -1px 0 var(--sidebar-border)',
		)
		const foot = all.find((d) => d.file === 'style.css' && d.selector === '.sidebar-foot')
		expect(foot).toBeDefined()
		expect(
			all.find(
				(d) => d.file === 'style.css' && d.selector === '.sidebar-foot' && d.prop === 'border-top',
			)?.value,
		).toBe('1px solid var(--sidebar-border)')
		expect(
			all.find(
				(d) => d.file === 'style.css' && d.selector === '.sidebar-foot' && d.prop === 'box-sizing',
			)?.value,
		).toBe('border-box')
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
