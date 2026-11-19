import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { contextRingModel } from './context-ring.js'
import { usageLimitsModel } from './usage-limits-model.js'
import { type UsageLimitsControl, UsageLimitsPanel } from './usage-limits-popover.js'

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)
const control = (onDetails?: () => void, onSeeAll?: () => void): UsageLimitsControl => ({
	view: undefined,
	budgets: {},
	onBudget: () => {},
	onOpen: () => {},
	now: () => NOW,
	...(onDetails ? { onDetails } : {}),
	...(onSeeAll ? { onSeeAll } : {}),
})
const context = contextRingModel({ contextTokens: 701, contextWindowTokens: 1_000_000 } as never)

const html = (
	view: Parameters<typeof usageLimitsModel>[0]['view'],
	onDetails?: () => void,
	onSeeAll?: () => void,
) =>
	renderToStaticMarkup(
		createElement(UsageLimitsPanel, {
			model: usageLimitsModel({ view, now: NOW, timeZone: 'UTC' }),
			context,
			control: control(onDetails, onSeeAll),
		}),
	)

describe('the usage limits popover', () => {
	it('is one context row, with no header and no sentence, when no limits are known', () => {
		const out = html(
			{ providers: [{ provider: 'anthropic', label: 'Anthropic', kind: 'sign-in' }] },
			() => {},
		)
		expect(out).not.toContain('Your usage limits')
		expect(out).not.toContain('not reported')
		expect(out.match(/aria-label="Context"/g)).toHaveLength(1)
		expect(out.match(/Context<\/span>/g)).toHaveLength(1)
		expect(out).toContain('Details')
		expect(out).not.toContain('Messages')
	})

	it('shows the plan in the title and a row per window above the one context row', () => {
		const out = html({
			providers: [
				{
					provider: 'anthropic',
					label: 'Anthropic',
					kind: 'sign-in',
					plan: 'Team',
					asOf: NOW,
					windows: [
						{ label: '5-hour limit', usedFraction: 0 },
						{ label: 'Weekly · all models', usedFraction: 0.38, resetsAt: NOW + 3 * 86_400_000 },
					],
				},
			],
		})
		expect(out).toContain('Your usage limits')
		expect(out).toContain('· Team')
		expect(out).toContain('Starts with your first message')
		expect(out).toContain('38%')
		expect(out.match(/data-row="window"/g)).toHaveLength(2)
		expect(out.match(/data-row="context"/g)).toHaveLength(1)
		expect(out).not.toContain('Details')
	})

	it('has See all at the right of the title, which opens Settings, and no budget field', () => {
		const view = {
			providers: [
				{
					provider: 'anthropic',
					label: 'Anthropic',
					kind: 'sign-in' as const,
					asOf: NOW,
					windows: [{ label: '5-hour limit', usedFraction: 0.2, resetsAt: NOW + 3600_000 }],
				},
				{
					provider: 'openai',
					label: 'OpenAI',
					kind: 'key' as const,
					spend: { usd: 3, days: 30, partial: false },
				},
			],
		}
		const out = html(view, undefined, () => {})
		expect(out).toMatch(
			/<div class="limits-heading"><h2 class="limits-title">[\s\S]*?<\/h2><button[^>]*>See all/,
		)
		expect(out).not.toContain('Set a budget')
		expect(out).not.toContain('Change budget')
		expect(html(view)).not.toContain('See all')
	})

	it('has no See all while no limit is known, since there is no title for it to sit beside', () => {
		expect(html({ providers: [] }, undefined, () => {})).not.toContain('See all')
	})
})
