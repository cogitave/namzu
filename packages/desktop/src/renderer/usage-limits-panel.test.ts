import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { contextRingModel } from './context-ring.js'
import { usageLimitsModel } from './usage-limits-model.js'
import { type UsageLimitsControl, UsageLimitsPanel } from './usage-limits-popover.js'

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)
const control = (onDetails?: () => void): UsageLimitsControl => ({
	view: undefined,
	budgets: {},
	onBudget: () => {},
	onOpen: () => {},
	now: () => NOW,
	...(onDetails ? { onDetails } : {}),
})
const context = contextRingModel({ contextTokens: 701, contextWindowTokens: 1_000_000 } as never)

const html = (view: Parameters<typeof usageLimitsModel>[0]['view'], onDetails?: () => void) =>
	renderToStaticMarkup(
		createElement(UsageLimitsPanel, {
			model: usageLimitsModel({ view, now: NOW, timeZone: 'UTC' }),
			context,
			control: control(onDetails),
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
})
