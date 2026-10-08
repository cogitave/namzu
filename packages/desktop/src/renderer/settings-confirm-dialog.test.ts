import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RETRUST_OFF_COPY, SettingsConfirmDialog } from './settings-confirm-dialog.js'

describe('SettingsConfirmDialog', () => {
	it('keeps the wording of the box it replaced', () => {
		expect(RETRUST_OFF_COPY.title).toBe('Stop asking when a folder’s automatic settings change?')
		expect(RETRUST_OFF_COPY.description).toBe(
			'A project can run hooks, MCP servers and plugins from its own files. With this off, Namzu will not ask again when they change, and changes made meanwhile are accepted as they are when you turn it back on.',
		)
		expect([RETRUST_OFF_COPY.cancel, RETRUST_OFF_COPY.confirm]).toEqual(['Cancel', 'Turn off'])
	})
	it('renders as nothing outside a browser (portal) without throwing', () => {
		const html = renderToStaticMarkup(
			createElement(SettingsConfirmDialog, {
				onConfirm: async () => undefined,
				onCancel: () => undefined,
			}),
		)
		expect(html).toBe('')
	})
})
