import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PaneTabs } from './pane-bodies.js'

/** A pane tab that cannot be closed has the same inset after its label as before its icon. */

const css = readFileSync(new URL('./file-panel/file-panel.css', import.meta.url), 'utf8')
const rule = (selector: string) => {
	const at = css.indexOf(`${selector} {`)
	return at < 0 ? '' : css.slice(at, css.indexOf('}', at))
}
const px = (block: string, property: string) =>
	new RegExp(`${property}:\\s*([^;]+);`).exec(block)?.[1]?.trim()

const render = (fixed: boolean) =>
	renderToStaticMarkup(
		createElement(PaneTabs, {
			label: 'Browser tabs',
			tabs: [{ id: 'b', label: 'Browser', fixed }],
			active: 'b',
			onSelect: () => {},
			onClose: () => {},
		}),
	)

describe('a pane tab with no close button', () => {
	it('ends with its name button, so the last-child rule applies to it', () => {
		const html = render(true)
		expect(html).not.toContain('panel-tab-close')
		expect(html).toMatch(/class="panel-tab-name"[^>]*>.*<\/button><\/div>/)
	})

	it('pads its name 8 px on the right, the same as the 8 px before the icon', () => {
		const left = px(rule('.panel-tab-name'), 'padding')?.split(/\s+/)
		expect(left?.[3]).toBe('8px')
		expect(px(rule('.panel-tab-name:last-child'), 'padding-right')).toBe('8px')
	})

	it('keeps the close button after the name when the tab can be closed', () => {
		const html = render(false)
		expect(html.indexOf('panel-tab-name')).toBeLessThan(html.indexOf('panel-tab-close'))
		// With a close button after it, the name keeps its short 2 px end.
		expect(px(rule('.panel-tab-name'), 'padding')).toBe('0 2px 0 8px')
	})
})
