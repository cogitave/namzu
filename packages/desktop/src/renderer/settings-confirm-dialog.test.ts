import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RETRUST_OFF_COPY, SettingsConfirmDialog } from './settings-confirm-dialog.js'

describe('SettingsConfirmDialog', () => {
	it('says project, as the switch does, and names one concrete risk', () => {
		expect(RETRUST_OFF_COPY.title).toBe('Stop asking when a project’s automatic settings change?')
		expect(RETRUST_OFF_COPY.description).toBe(
			'Hooks, servers and plugins a project adds later will run without asking. Changes made while this is off are accepted when you turn it back on.',
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
