import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ExtensionRow } from '../shared/extensions-view.js'
import { ExtensionPageFrame } from './extension-page-frame.js'
import { PANEL_FOR_TARGET } from './extension-page-pane.js'

const row = {
	id: 'com.example.record',
	name: 'Activity Tracker',
	version: '0.2.0',
	publisher: 'Cogitave',
	state: 'running',
	chip: 'Running',
	dev: false,
	needs: [],
	enabled: true,
	licenceKind: 'key',
	languages: ['en'],
	shownLocale: 'en',
	running: true,
	grants: [],
	ui: {
		icon: 'ui/icon.svg',
		accent: '#2F6F4F',
		pages: [{ id: 'today', title: "Today's record", slot: 'settings', usesNetwork: false }],
		chips: [],
	},
} as unknown as ExtensionRow

const frame = (over: Partial<ExtensionRow> = {}) =>
	renderToStaticMarkup(
		createElement(ExtensionPageFrame, {
			api: {} as never,
			row: { ...row, ...over },
			pageId: 'today',
			onBack: () => {},
			onOpenNamzu: () => {},
		}),
	)

describe("an extension's page in the main pane", () => {
	it("has Namzu's thin strip: a way back, the name, who drew it, and the links to permissions and licence", () => {
		const markup = frame()
		expect(markup).toContain('aria-label="Back"')
		expect(markup).toContain('<strong>Activity Tracker</strong>')
		expect(markup).toContain('Page drawn by Cogitave')
		expect(markup).toContain('Permissions and notice')
		expect(markup).toContain('>Licence<')
	})

	it('has no Licence link for an extension that needs none', () => {
		expect(frame({ licenceKind: 'none' })).not.toContain('>Licence<')
	})

	it('keeps the sentence about keys and passwords in the info mark, not as a line of the strip', () => {
		const markup = frame()
		const sentence = 'Namzu never asks for a key or a password inside an extension page.'
		expect(markup).toContain(`title="${sentence}"`)
		expect(markup).toContain(`aria-label="${sentence}"`)
		// Said once, as the tooltip and its name; not drawn as text.
		expect(markup).not.toContain(`>${sentence}<`)
		expect(markup).not.toContain('extension-page-warning')
	})

	it('is not a dialog and has no dialog role, so the page is never hidden behind itself', () => {
		const markup = frame()
		expect(markup).not.toContain('role="dialog"')
		expect(markup).not.toContain('<dialog')
	})

	it("sends a page's request for a Namzu screen to that extension's screen in Settings", () => {
		expect(PANEL_FOR_TARGET).toEqual({
			notice: 'notice',
			permissions: 'notice',
			licence: 'licence',
			record: 'record',
			'what-is-collected': 'collected',
		})
	})

	it('fills the pane under the window top bar with one slot that takes the height that is left', () => {
		const css = readFileSync(
			fileURLToPath(new URL('./extension-page-pane.css', import.meta.url)),
			'utf8',
		)
		expect(css).toMatch(/\.extension-page-pane\s*\{[^}]*position:\s*absolute/)
		expect(css).toMatch(/inset:\s*var\(--workspace-topbar-height/)
		expect(css).toMatch(/\.extension-page-slot\s*\{[^}]*flex:\s*1/)
		expect(css).not.toMatch(/min-height:\s*360px/)
	})
})
