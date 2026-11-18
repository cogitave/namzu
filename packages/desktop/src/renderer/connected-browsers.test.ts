import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConnectedBrowsersRow, connectedBrowserLines } from './connected-browsers.js'

describe('the Connected browsers table', () => {
	it('lists the built-in browser and the browser the engine drives, each with a state', () => {
		const lines = connectedBrowserLines(true, {
			loading: false,
			view: { state: 'ready', text: 'windows-cdp: Google Chrome on Windows, a visible window.' },
		})
		expect(lines.map((line) => [line.name, line.state])).toEqual([
			['Built-in browser', 'Ready'],
			['Browser Namzu drives', 'Ready'],
		])
		expect(lines[1]?.detail).toContain('Google Chrome')
	})

	it('says each way the engine side can fail to be known or to run, in words', () => {
		const state = (read: Parameters<typeof connectedBrowserLines>[1]) =>
			connectedBrowserLines(false, read)[1]?.state
		expect(state({ loading: true })).toBe('Checking')
		expect(state({ loading: false, view: null })).toBe('Not known')
		expect(state({ loading: false, error: 'It stopped.' })).toBe('Not known')
		expect(state({ loading: false, view: { state: 'off', text: 'x' } })).toBe('Switched off')
		expect(state({ loading: false, view: { state: 'unavailable', text: 'x' } })).toBe(
			'Not available',
		)
		expect(state({ loading: false, view: { state: 'missing', text: 'x' } })).toBe('Not installed')
		expect(state({ loading: false, view: { state: 'warning', text: 'x' } })).toBe(
			'Ready, with a note',
		)
		expect(connectedBrowserLines(false, { loading: true })[0]?.state).toBe('Not available here')
	})

	it('draws a table with a Recheck button, switched off while a check is running', () => {
		const html = renderToStaticMarkup(
			createElement(ConnectedBrowsersRow, {
				bridge: {
					engineBrowser: async () => null,
					browserPane: async () => ({ sessionId: 's', tabs: [] }),
				},
			}),
		)
		expect(html).toContain('id="setting-connected-browsers"')
		expect(html).toContain('Built-in browser')
		expect(html).toContain('Browser Namzu drives')
		expect(html).toContain('Recheck')
		// A first paint is already checking, so the button waits.
		expect(html).toMatch(/<button[^>]*disabled[^>]*>Recheck/)
	})
})
