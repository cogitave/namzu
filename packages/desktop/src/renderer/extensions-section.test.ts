import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionsLayer } from './extensions-layer.js'
import { ExtensionsSection } from './extensions-section.js'
import { refreshExtensions, selectExtension, snapshotForTest } from './extensions-store.js'

const ROW = {
	id: 'com.example.record',
	name: 'Activity Tracker',
	version: '0.2.0',
	publisher: 'Cogitave',
	state: 'running',
	chip: 'Running',
	dev: true,
	needs: [],
	enabled: true,
	languages: ['en'],
	shownLocale: 'en',
	running: true,
	grants: [],
	licenceKind: 'key',
	licence: { customer: 'Example Co', seats: 5, expires: '2027-06-30T00:00:00Z' },
	record: { acknowledgedAt: '2026-11-19T08:41:00Z', noticeVersion: '1.2', locale: 'en' },
	background: {
		indicator: 'tray',
		indicatorLabel: 'Recording',
		defaultOn: true,
		enabled: true,
		hostedBy: 'runner',
	},
	ui: {
		icon: 'ui/icon.svg',
		accent: '#2F6F4F',
		pages: [{ id: 'today', title: "Today's record", slot: 'settings', usesNetwork: false }],
		chips: [{ id: 'rec', state: 'collecting', label: 'Recording', tone: 'ok' }],
	},
	indicator: { level: 'ok', label: 'Activity Tracker is recording.' },
}
const OFF = {
	...ROW,
	id: 'com.example.notes',
	name: 'Meeting Notes',
	version: '1.4.2',
	publisher: 'Example Publisher',
	state: 'ready',
	enabled: false,
	running: false,
	dev: false,
	background: undefined,
	ui: undefined,
	indicator: undefined,
}
const WAITING = {
	...OFF,
	id: 'com.example.checks',
	name: 'Release Checks',
	state: 'needs-notice',
	needs: ['notice'],
}

const api = (extensions: unknown[]) =>
	({ extensionsCall: vi.fn(async () => ({ extensions })) }) as never

beforeEach(() => selectExtension(undefined))

describe('Settings, Extensions: the list', () => {
	it('draws one row for each extension with its publisher, version and one state word', async () => {
		await refreshExtensions(api([ROW, OFF, WAITING]))
		const markup = renderToStaticMarkup(createElement(ExtensionsSection, {}))
		expect(markup).toContain('<h1>Extensions</h1>')
		expect(markup).toContain('Add from file')
		expect(markup.match(/class="extension-list-row"/g)).toHaveLength(3)
		expect(markup).toContain('Cogitave · 0.2.0')
		expect(markup).toContain('Example Publisher · 1.4.2')
		// The words are the extension's own while it runs, Namzu's otherwise.
		expect(markup).toMatch(/data-tone="on"[^>]*>.*?Recording/)
		expect(markup).toMatch(/data-tone="off"[^>]*>.*?Off/)
		expect(markup).toMatch(/data-tone="warn"[^>]*>.*?Needs your notice/)
		// No row of buttons: a row is one button that opens the screen.
		expect(markup).not.toContain('Disable')
		expect(markup).not.toContain('Remove')
		// Not every extension collects anything: the list says nothing about what one collects.
		expect(markup).not.toContain('Open one to see')
		expect(markup).not.toContain('extension-list-hint')
	})

	it('says plainly that there are none, with no technical word', async () => {
		await refreshExtensions(api([]))
		const markup = renderToStaticMarkup(createElement(ExtensionsSection, {}))
		expect(markup).toContain('No extensions yet')
		expect(markup).toContain('Add from file')
		expect(markup).not.toMatch(/manifest|daemon|runner|process|signature/i)
	})

	it('draws nothing for the window chrome: no mark, no chip, no extension rows outside Settings', async () => {
		await refreshExtensions(api([ROW]))
		const layer = renderToStaticMarkup(
			createElement(ExtensionsLayer, {
				api: {} as never,
				pane: { current: null },
				openSettings: () => {},
				closeSettings: () => {},
			}),
		)
		expect(layer).toBe('')
		expect(layer).not.toContain('extension-indicator')
	})
})

describe("Settings, Extensions: an extension's own screen", () => {
	it('names the extension with a way back, its publisher and version, and the Dev key mark', async () => {
		await refreshExtensions(api([ROW, OFF]))
		selectExtension(ROW.id)
		expect(snapshotForTest().selected).toBe(ROW.id)
		const markup = renderToStaticMarkup(createElement(ExtensionsSection, {}))
		expect(markup).toContain('aria-label="Back to Extensions"')
		expect(markup).toContain('Activity Tracker')
		expect(markup).toContain('Cogitave · 0.2.0')
		expect(markup).toContain('Dev key')
		expect(markup).not.toContain('Add from file')
	})

	it("draws the groups in order, with Settings' own rows and switches", async () => {
		await refreshExtensions(api([ROW]))
		selectExtension(ROW.id)
		const markup = renderToStaticMarkup(createElement(ExtensionsSection, {}))
		const titles = [...markup.matchAll(/<h2 class="settings-section-title">([^<]+)<\/h2>/g)].map(
			(m) => m[1]?.replace('&#x27;', "'"),
		)
		expect(titles).toEqual([
			"Today's record",
			'Background',
			'What is collected',
			'Settings',
			'Licence',
			'Notice and my record',
			'Activity log',
			'Remove',
		])
		expect(markup).toContain('class="settings-row"')
		expect(markup).toMatch(/<input[^>]*role="switch"[^>]*aria-label="Activity Tracker"/)
		expect(markup).toMatch(/<input[^>]*role="switch"[^>]*aria-label="Start when I sign in"/)
		expect(markup).toContain('Open today&#x27;s record')
		expect(markup).toContain('Example Co')
		expect(markup).toContain('Change licence…')
		expect(markup).toContain('Open the activity log')
		expect(markup).toContain('Remove…')
	})

	it('has no Today group for an extension with no page, and no Background group for one that has none', async () => {
		await refreshExtensions(api([OFF]))
		selectExtension(OFF.id)
		const markup = renderToStaticMarkup(createElement(ExtensionsSection, {}))
		expect(markup).not.toContain('Today&#x27;s record')
		expect(markup).not.toContain('>Background<')
		expect(markup).toContain('It is off. Turn it on to start it.')
	})

	it('offers the notice, not a switch, while the notice is unread', async () => {
		await refreshExtensions(api([WAITING]))
		selectExtension(WAITING.id)
		const markup = renderToStaticMarkup(createElement(ExtensionsSection, {}))
		expect(markup).toContain('Read what it collects and why before it can start.')
		expect(markup).not.toMatch(/role="switch"[^>]*aria-label="Release Checks"/)
		expect(markup).toContain('>Read the notice<')
	})
})
