import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { activityTab, changesTab, fileTab } from './file-tabs.js'
import { PanelTabStrip, closesTab, tabLabel } from './panel-tabs.js'

const noop = () => {}
/** The tab buttons that sit in the tab order. */
const tabStops = (html: string) =>
	(html.match(/<button[^>]*role="tab"[^>]*>/g) ?? []).filter((tag) => tag.includes('tabindex="0"'))
function strip(overrides: Partial<Parameters<typeof PanelTabStrip>[0]> = {}) {
	return renderToStaticMarkup(
		createElement(PanelTabStrip, {
			tabs: [changesTab, activityTab, fileTab('docs/design-system.md')],
			active: changesTab,
			browsing: false,
			canBrowse: true,
			running: 0,
			attention: false,
			expanded: false,
			onActivate: noop,
			onClose: noop,
			onOpenTab: noop,
			onBrowse: noop,
			onToggleExpanded: noop,
			onHide: noop,
			...overrides,
		}),
	)
}

describe('panel tab strip', () => {
	it('renders every tab through one component, each closable', () => {
		const html = strip()
		expect(html.split('class="panel-tab"')).toHaveLength(4)
		expect(html.match(/role="tab"/g)).toHaveLength(3)
		for (const name of ['Close Changes', 'Close Activity', 'Close design-system.md'])
			expect(html).toContain(`aria-label="${name}"`)
	})
	it('marks the active tab and gives only it a tab stop', () => {
		const html = strip()
		expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
		expect(tabStops(html)).toHaveLength(1)
		expect(html).toMatch(
			/aria-selected="true"[^>]*data-tab="changes"|data-tab="changes"[^>]*aria-selected="true"/,
		)
	})
	it('keeps the first tab reachable when none is selected', () => {
		const html = strip({ active: undefined, browsing: true })
		expect(html).not.toContain('aria-selected="true"')
		expect(tabStops(html)).toHaveLength(1)
	})
	it('shows a count on Activity only while work runs, in the warning style when it needs attention', () => {
		expect(strip()).not.toContain('panel-tab-badge')
		const running = strip({ running: 3 })
		expect(running).toContain('panel-tab-badge')
		expect(running).toContain('aria-label="Activity, 3 running"')
		expect(running).not.toContain('data-attention')
		const needs = strip({ running: 2, attention: true })
		expect(needs).toContain('data-attention="true"')
		expect(needs).toContain('Activity, 2 running, needs attention')
		expect(strip({ running: 120 })).toContain('99+')
	})
	it('names the expand button by state and always offers Hide panel', () => {
		expect(strip()).toContain('aria-label="Expand panel"')
		expect(strip({ expanded: true })).toContain('aria-label="Restore panel"')
		expect(strip({ expanded: true })).toContain('aria-pressed="true"')
		expect(strip()).toContain('aria-label="Hide panel"')
	})
	it('offers the add menu while there is something to add', () => {
		expect(strip()).toContain('aria-label="Add a tab"')
		expect(strip({ canBrowse: false })).not.toContain('aria-label="Add a tab"')
		expect(strip({ canBrowse: false, tabs: [changesTab] })).toContain('aria-label="Add a tab"')
	})
	it('labels files by name', () => {
		expect(tabLabel(fileTab('a/b/c.ts'))).toBe('c.ts')
		expect(tabLabel(changesTab)).toBe('Changes')
	})
})

describe('closing a tab from the keyboard', () => {
	const key = (key: string, extra: object = {}) => ({
		key,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		...extra,
	})
	it('closes on Delete, Ctrl+W and Cmd+W', () => {
		expect(closesTab(key('Delete'))).toBe(true)
		expect(closesTab(key('w', { ctrlKey: true }))).toBe(true)
		expect(closesTab(key('W', { metaKey: true }))).toBe(true)
	})
	it('ignores other keys and modified Delete', () => {
		expect(closesTab(key('w'))).toBe(false)
		expect(closesTab(key('Backspace'))).toBe(false)
		expect(closesTab(key('Delete', { ctrlKey: true }))).toBe(false)
		expect(closesTab(key('w', { ctrlKey: true, shiftKey: true }))).toBe(false)
		expect(closesTab(key('ArrowRight'))).toBe(false)
	})
})
