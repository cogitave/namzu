import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { LimitsNotification } from '../shared/limits-protocol.js'
import type { UsageLimitsControl } from './usage-limits-popover.js'
import { UsageSection } from './usage-section.js'

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)

const control = (
	view: LimitsNotification | undefined,
	budgets: Record<string, number> = {},
): UsageLimitsControl => ({
	view,
	budgets,
	onBudget: () => {},
	onOpen: () => {},
	now: () => NOW,
})

const render = (c: UsageLimitsControl | undefined) =>
	renderToStaticMarkup(createElement(UsageSection, { control: c }))

const view: LimitsNotification = {
	providers: [
		{
			provider: 'anthropic',
			label: 'Anthropic',
			kind: 'sign-in',
			plan: 'Team',
			asOf: NOW - 20 * 60_000,
			windows: [
				{ label: '5-hour limit', usedFraction: 0, resetsAt: undefined },
				{ label: 'Weekly · all models', usedFraction: 0.38, resetsAt: NOW + 3 * 86_400_000 },
			],
		},
		{
			provider: 'openai',
			label: 'OpenAI',
			kind: 'key',
			spend: { usd: 3, days: 30, partial: false },
		},
		{ provider: 'silent', label: 'Silent', kind: 'sign-in' },
	],
}

describe('Settings, Usage', () => {
	it('lists each provider with the popover rows, its plan, and the age of an old reading', () => {
		const out = render(control(view))
		expect(out).toContain('Anthropic')
		expect(out).toContain('· Team')
		expect(out).toContain('5-hour limit')
		expect(out).toContain('Starts with your first message')
		expect(out).toContain('38%')
		expect(out).toContain('as of 20 min ago')
		expect(out.match(/data-row="window"/g)).toHaveLength(2)
		expect(out.match(/class="limits-bar"/g)?.length).toBeGreaterThanOrEqual(2)
		expect(out).toContain('OpenAI')
	})

	it('says nothing for a provider that reports nothing, and no "not reported" sentence', () => {
		const out = render(control(view))
		expect(out).not.toContain('Silent')
		expect(out.toLowerCase()).not.toContain('not reported')
		const empty = render(
			control({ providers: [{ provider: 'silent', label: 'Silent', kind: 'sign-in' }] }),
		)
		expect(empty).not.toContain('Silent')
		expect(empty.toLowerCase()).not.toContain('not reported')
		expect(empty).not.toContain('settings-row')
		expect(render(undefined)).toContain('id="setting-usage-limits"')
	})

	it('keeps the stored budget in the field, only beside a spend estimate', () => {
		const out = render(control(view, { openai: 25 }))
		expect(out).toContain('Spending budget')
		expect(out).toMatch(/<input[^>]*value="25"/)
		expect(out).toContain('of $25.00 budget')
		expect(out.match(/Spending budget<\/h3>/g)).toHaveLength(1)
		expect(render(control(view))).toMatch(/<input[^>]*placeholder="No budget"/)
	})
})
