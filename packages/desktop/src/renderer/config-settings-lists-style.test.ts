import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ListEditor, TypedList } from './config-settings-lists.js'

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

	it('draws app names in the interface font and leaves other lists as they were', () => {
		const view = (itemLabel: string) =>
			renderToStaticMarkup(
				createElement(TypedList, {
					descriptor: { path: 'x', label: 'X' } as never,
					control: { kind: 'list', itemLabel } as never,
					value: ['Calendar'],
					config: { change: () => undefined } as never,
				}),
			)
		expect(view('app')).toContain('settings-config-item settings-config-name')
		expect(view('folder')).not.toContain('settings-config-name')
	})
})

describe('the plain line on a row something has turned off', () => {
	it('names who turned it off', async () => {
		const { turnedOffNote } = await import('../shared/config-settings-values.js')
		expect(turnedOffNote('managed')).toBe('Turned off by your administrator.')
		expect(turnedOffNote('user')).toBe('Turned off in your config file.')
		expect(turnedOffNote('project')).toBe('Turned off by this project.')
	})
})
