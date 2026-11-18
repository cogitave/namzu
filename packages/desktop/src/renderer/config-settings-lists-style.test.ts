import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ListEditor } from './config-settings-lists.js'

const base = {
	label: 'Rules',
	itemLabel: 'rule',
	items: ['Reading public documentation pages', 'src/**/*.ts'],
	onChange: () => undefined,
}

describe('how the entries of a list are drawn', () => {
	it('keeps the monospace style for tools, paths and patterns', () => {
		const html = renderToStaticMarkup(createElement(ListEditor, base))
		expect(html).toContain('<span class="settings-config-item">src/**/*.ts</span>')
		expect(html).not.toContain('settings-config-name')
	})

	it('draws sentences in the plain name style', () => {
		const html = renderToStaticMarkup(createElement(ListEditor, { ...base, sentences: true }))
		expect(html).toContain('settings-config-item settings-config-name')
		expect(html.match(/settings-config-name/g)).toHaveLength(2)
	})
})
