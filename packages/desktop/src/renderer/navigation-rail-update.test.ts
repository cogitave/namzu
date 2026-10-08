import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { UpdateState } from '../shared/update-protocol.js'
import { NavigationRail } from './navigation-rail.js'

const rail = (state?: UpdateState) =>
	renderToStaticMarkup(
		createElement(NavigationRail, {
			section: 'home',
			onHome: () => {},
			onSpaces: () => {},
			onPlugins: () => {},
			onSettings: () => {},
			onOpenProject: () => {},
			onToggleSidebar: () => {},
			update: state ? { state, onOpen: () => {}, onCheck: () => {} } : undefined,
		}),
	)

describe('the rail update badge', () => {
	it('is a labelled button above the profile control only when an update is ready', () => {
		const markup = rail({ status: 'ready', version: '0.2.0' })
		const badge = markup.indexOf(
			'aria-label="Update ready. Restart Namzu to install version 0.2.0"',
		)
		expect(badge).toBeGreaterThan(-1)
		expect(badge).toBeLessThan(markup.indexOf('aria-label="Profile"'))
		expect(markup).toContain('rail-update-button')
		expect(markup).toContain('aria-hidden="true"')
	})

	it('is absent otherwise, and absent without an updater', () => {
		for (const state of [
			{ status: 'disabled' },
			{ status: 'idle' },
			{ status: 'checking' },
			{ status: 'downloading', percent: 5, bytesPerSecond: 1 },
			{ status: 'installing', version: '0.2.0', phase: 'preparing' },
		] as UpdateState[])
			expect(rail(state)).not.toContain('rail-update-button')
		expect(rail()).not.toContain('rail-update-button')
		expect(rail()).not.toContain('<output')
	})

	it('keeps a polite live region for the one announcement', () => {
		expect(rail({ status: 'idle' })).toContain('<output class="sr-only" aria-live="polite">')
	})
})
