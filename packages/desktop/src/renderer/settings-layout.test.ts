import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { LimitsNotification } from '../shared/limits-protocol.js'
import type { UsageLimitsControl } from './usage-limits-popover.js'
import { UsageSection } from './usage-section.js'

const dir = dirname(fileURLToPath(import.meta.url))
const css = (name: string) => readFileSync(join(dir, name), 'utf8')
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)

const view: LimitsNotification = {
	providers: [
		{
			provider: 'anthropic',
			label: 'Anthropic',
			kind: 'sign-in',
			plan: 'Team',
			asOf: NOW,
			windows: [{ label: 'Weekly · all models', usedFraction: 0.3, resetsAt: NOW + 86_400_000 }],
		},
	],
}
const control: UsageLimitsControl = {
	view,
	budgets: {},
	onBudget: () => {},
	onOpen: () => {},
	now: () => NOW,
}

describe('Settings layout rules', () => {
	it('draws a usage row as label, note, bar and a "used" percent, in that source order', () => {
		const out = renderToStaticMarkup(createElement(UsageSection, { control }))
		expect(out).toContain('data-variant="settings"')
		expect(out).toContain('30%')
		expect(out).toContain(' used')
		const at = (needle: string) => out.indexOf(needle)
		expect(at('limits-label')).toBeLessThan(at('limits-percent'))
		expect(at('limits-percent')).toBeLessThan(at('limits-note'))
		expect(at('limits-note')).toBeLessThan(at('class="limits-bar"'))
	})

	it('lays the Settings usage row out as three columns without a width cap', () => {
		const usage = css('usage-section.css')
		expect(usage).not.toMatch(/max-width:\s*480px/)
		expect(usage).toMatch(/grid-template-columns:\s*196px minmax\(0, 1fr\) 72px/)
		expect(usage).toMatch(/column-gap:\s*40px/)
		expect(usage).toMatch(/@container settings-dialog/)
		// The popover keeps its stacked rows: the grid is only under .usage-rows.
		expect(css('usage-limits-popover.css')).not.toContain('grid-template-columns')
	})

	it('keeps a "100% used" percent inside its column and a note-less stacked row free of a blank track', () => {
		const usage = css('usage-section.css')
		expect(usage).not.toMatch(/grid-template-columns:\s*196px minmax\(0, 1fr\) 56px;/)
		expect(usage).not.toMatch(/max-content/)
		const narrow = usage.slice(usage.indexOf('@container settings-dialog'))
		expect(narrow).toMatch(/grid-template-areas:\s*"label percent" "bar bar";/)
		expect(narrow).toMatch(/:has\(\.limits-note\)\s*\{[^}]*"label percent" "note note" "bar bar"/)
	})

	it('keeps a lone switch or button beside its label under 640 px', () => {
		const page = css('settings-page.css')
		const block = page.slice(page.indexOf('@container settings-dialog (max-width: 640px)'))
		expect(block.slice(0, block.indexOf('@container', 10))).toMatch(
			/:not\(\s*:has\(> \.settings-row-control > :is\(\.settings-switch, button\):only-child\)/,
		)
		// Rows drawn from the engine's config put the switch inside .settings-config-control.
		expect(block).toMatch(/\.settings-config-control \.settings-switch/)
	})

	it('lets a number field shrink beside its unit in the 640-760 px band', () => {
		const page = css('settings-page.css')
		const band = page.slice(page.indexOf('@container settings-dialog (max-width: 760px)'))
		const block = band.slice(0, band.indexOf('@container settings-dialog (max-width: 640px)'))
		expect(block).toMatch(/\.settings-config-field \{[^}]*flex-wrap: nowrap/)
		expect(block).toMatch(
			/input\.settings-config-number \{[^}]*flex: 0 1 220px[^}]*min-width: 80px/,
		)
	})

	it('has one shared rule that makes stacked controls and numbers span or end at the column edge', () => {
		const page = css('settings-page.css')
		expect(page).toMatch(
			/\.settings-row\[data-stacked\] > \.settings-row-control \{[^}]*width: 100%/,
		)
		expect(page).toMatch(/\.settings-row-control input\.settings-config-number \{[^}]*width: 220px/)
		expect(page).toMatch(/@container settings-dialog \(max-width: 640px\)/)
		expect(page).not.toMatch(/\.settings-config-checks\[data-scroll\] \{[^}]*max-height/)
		expect(css('extensions-section.css')).toMatch(/\.extension-list-row \{[^}]*padding: 12px 0;/)
	})
})
