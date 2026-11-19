import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Layout rules found by looking at the real window (the layout sweep), kept as checks on the stylesheets
// so they cannot slip back. Each reads a rule's declarations; nothing here depends on time or a browser.

const read = (name: string) =>
	readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8').replace(
		/\/\*[\s\S]*?\*\//g,
		'',
	)

/** The declarations of the first rule whose selector list is exactly `selector`, as a map. */
function rule(css: string, selector: string): Record<string, string> {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const match = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`).exec(css)
	if (!match) throw new Error(`no rule for ${selector}`)
	const out: Record<string, string> = {}
	for (const line of (match[1] as string).split(';')) {
		const colon = line.indexOf(':')
		if (colon > 0) out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
	}
	return out
}

describe('the conversation bar', () => {
	const css = read('conversation-bar.css')
	it('the project label gives way before the title, and the title keeps a floor', () => {
		const project = rule(css, '.conversation-bar-project')
		expect(project['min-width']).toBe('0')
		expect(Number(project.flex?.split(/\s+/)[1])).toBeGreaterThan(1)
		expect(rule(css, '.conversation-bar-title')['min-width']).toBe('min(100%, 96px)')
	})
	it('the project is hidden while the bar still has room for a whole title', () => {
		const query =
			/@container conversation-bar \(max-width: (\d+)px\)\s*\{\s*\.conversation-bar-project/.exec(
				css,
			)
		expect(Number(query?.[1])).toBeGreaterThanOrEqual(440)
	})
})

describe('the session panel', () => {
	const css = read('session-panel.css')
	it('every heading is one 24 px control in full ink, 13 px at weight 500', () => {
		const heading = rule(css, '.session-section-head h3')
		expect(heading.height).toBe('24px')
		expect(heading.color).toBe('var(--foreground)')
		expect(heading['font-size']).toBe('var(--text-small)')
		expect(heading['font-weight']).toBe('var(--weight-control)')
	})
	it('rows are 32 px apart with no gap, in every list', () => {
		expect(rule(css, '.session-row')['min-height']).toBe('32px')
		expect(rule(css, '.session-list > li')['min-height']).toBe('32px')
		expect(rule(css, '.session-changes-open')['min-height']).toBe('32px')
	})
	it('the hairline between sections is inset 16 px and there is none after the last', () => {
		expect(rule(css, '.session-section:not(:last-child)::after').inset).toBe('auto 16px 0')
		expect(rule(css, '.session-section')['border-bottom']).toBeUndefined()
	})
	it('the folder path is cut at its end, not at its start', () => {
		expect(rule(css, '.session-path').direction).toBeUndefined()
	})
	it('the close button is the 28 px control the other panels use', () => {
		expect(rule(css, '.session-panel-head .pane-control').width).toBe('var(--frame-control-size)')
	})
})

describe('the context breakdown', () => {
	const css = read('context-panel.css')
	it('its row gap leaves a built-in label its whole name at 900 px', () => {
		expect(rule(css, '.context-panel-row')['column-gap']).toBe('10px')
	})
	it('the free-space marker is an outline, so it shows on the panel ground', () => {
		expect(
			rule(css, '.context-panel-row[data-kind="free"] .context-panel-square').border,
		).toContain('muted-foreground')
	})
	it('a heading draws its chevron only while it is folded', () => {
		const source = readFileSync(
			fileURLToPath(new URL('./context-panel.tsx', import.meta.url)),
			'utf8',
		)
		expect(source).toContain('{!details && <ChevronRightIcon')
	})
})

describe('the composer menus', () => {
	it('a permission row is one line of description, so a row is 46 px', () => {
		const source = readFileSync(
			fileURLToPath(new URL('./composer-permissions.tsx', import.meta.url)),
			'utf8',
		)
		const copy = [...source.matchAll(/description: '([^']+)'/g)].map((m) => m[1] as string)
		const short = [
			'Asks before edits and commands.',
			'Edits files; asks for commands.',
			'A second model checks each step.',
		]
		for (const line of short) {
			expect(copy).toContain(line)
			expect(line.length).toBeLessThanOrEqual(34)
		}
	})
	it('the model menu is sized by its list, not by the words after "More"', () => {
		const css = read('model-picker.css')
		const more = rule(css, '.model-picker-more > span:first-child')
		expect(more.contain).toBe('inline-size')
		expect(more['text-overflow']).toBe('ellipsis')
		expect(
			Number.parseInt(rule(css, '.model-picker-popup')['min-width'] ?? '', 10),
		).toBeGreaterThanOrEqual(200)
	})
	it('the model menu is no wider than 340 px, with or without the engine choice', () => {
		const source = readFileSync(
			fileURLToPath(new URL('./model-picker.tsx', import.meta.url)),
			'utf8',
		)
		expect(source).toContain('engineControl ? 340 : 320')
	})
	it('the Hypermode row sits on the same inset as the model rows', () => {
		const css = read('composer-effort-panel.css')
		expect(rule(css, '.composer-effort-panel[data-variant="inline"]').padding).toContain(
			'var(--menu-padding)',
		)
	})
	it('the plus menu is as wide as its rows and keeps the standard gap above the box', () => {
		expect(rule(read('composer-menus.css'), '.composer-add-popup').width).toBe('max-content')
		const source = readFileSync(
			fileURLToPath(new URL('./composer-add-menu.tsx', import.meta.url)),
			'utf8',
		)
		expect(source).toContain('sideOffset={MENU_OFFSET}')
	})
	it('the context popover is no wider than a menu', () => {
		expect(rule(read('context-panel.css'), '.context-panel-popup').width).toBe('320px')
	})
})
