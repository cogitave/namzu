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
			onSettings: () => {},
			update: state ? { state, onOpen: () => {}, onCheck: () => {} } : undefined,
		}),
	)

/** The aria-label of every <button>, in document order. */
const labels = (markup: string) =>
	[...markup.matchAll(/<button\b[^>]*>/g)].map((m) => /aria-label="([^"]*)"/.exec(m[0])?.[1])

describe('the rail update badge', () => {
	it('is a labelled button directly above Settings, the last item, only when an update is ready', () => {
		const markup = rail({ status: 'ready', version: '0.2.0' })
		const badge = markup.indexOf(
			'aria-label="Update ready. Restart Namzu to install version 0.2.0"',
		)
		expect(badge).toBeGreaterThan(-1)
		expect(labels(markup).slice(-2)).toEqual([
			'Update ready. Restart Namzu to install version 0.2.0',
			'Settings',
		])
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

	it('has no profile control, and Settings is last with or without an update', () => {
		for (const markup of [rail(), rail({ status: 'ready', version: '0.2.0' })]) {
			expect(markup).not.toContain('Profile')
			expect(markup).not.toContain('rail-profile')
			expect(labels(markup).at(-1)).toBe('Settings')
		}
		expect(labels(rail())).toEqual(['Home', 'Settings'])
	})

	it('keeps a polite live region for the one announcement', () => {
		expect(rail({ status: 'idle' })).toContain('<output class="sr-only" aria-live="polite">')
	})
})

describe('the collapsed rail', () => {
	it('keeps one button in the foot and stacks the rest above its line, one per row', () => {
		const markup = rail({ status: 'ready', version: '0.2.0' })
		const foot = markup.slice(markup.indexOf('class="rail-foot"'))
		expect(foot.match(/<button\b/g)?.length).toBe(1)
		expect(foot).toContain('aria-label="Settings"')
		const stack = markup.slice(
			markup.indexOf('class="rail-stack"'),
			markup.indexOf('class="rail-foot"'),
		)
		expect(stack).toContain('rail-update-button')
	})

	it('lays the stack out as a column of foot-sized buttons', async () => {
		const { readFileSync } = await import('node:fs')
		const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
		expect(css).toMatch(/\.rail-stack \{[^}]*flex-direction: column;/)
		expect(css).toMatch(/\.rail-stack > \.rail-button \{[^}]*width: var\(--frame-foot-button\);/)
	})
})
