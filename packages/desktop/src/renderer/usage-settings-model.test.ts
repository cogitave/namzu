import { describe, expect, it } from 'vitest'
import type { LimitsNotification } from '../shared/limits-protocol.js'
import { readBudgets, writeBudgets } from './usage-limits-model.js'
import { parseBudgetDraft, usageSettingsModel } from './usage-settings-model.js'

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)

const view: LimitsNotification = {
	providers: [
		{ provider: 'silent', label: 'Silent', kind: 'sign-in' },
		{
			provider: 'openai',
			label: 'OpenAI',
			kind: 'key',
			spend: { usd: 3, days: 30, partial: false },
		},
		{
			provider: 'anthropic',
			label: 'Anthropic',
			kind: 'sign-in',
			plan: 'Team',
			asOf: NOW - 20 * 60_000,
			windows: [
				{ label: '5-hour limit', usedFraction: 0.4, resetsAt: NOW + 3600_000 },
				{ label: 'Weekly · all models', usedFraction: 0.1, resetsAt: NOW + 3 * 86_400_000 },
			],
		},
	],
}

describe('the Usage section model', () => {
	it('lists every provider that reported, the conversation provider first, and none that did not', () => {
		const model = usageSettingsModel({
			view,
			currentProvider: 'anthropic',
			now: NOW,
			timeZone: 'UTC',
		})
		expect(model.sections.map((section) => section.provider)).toEqual(['anthropic', 'openai'])
	})

	it('gives a provider the same rows as the popover, with its plan and the age of an old reading', () => {
		const model = usageSettingsModel({ view, now: NOW, timeZone: 'UTC' })
		const anthropic = model.sections.find((section) => section.provider === 'anthropic')
		expect(anthropic?.plan).toBe('Team')
		expect(anthropic?.rows).toEqual(
			model.limits.sections.find((s) => s.provider === 'anthropic')?.rows,
		)
		const first = anthropic?.rows[0]
		expect(first).toMatchObject({ shape: 'window', percent: '40%', reset: 'Resets at 1:00 PM' })
		expect(first?.shape === 'window' && first.asOf).toBe('as of 20 min ago')
		expect(anthropic?.budget).toBeUndefined()
	})

	it('offers a budget only beside a spend estimate, and carries the stored value', () => {
		const none = usageSettingsModel({ view, now: NOW })
		expect(none.sections.find((s) => s.provider === 'openai')?.budget).toEqual({
			provider: 'openai',
		})
		const set = usageSettingsModel({ view, now: NOW, budgets: { openai: 25 } })
		expect(set.sections.find((s) => s.provider === 'openai')?.budget).toEqual({
			provider: 'openai',
			usd: 25,
		})
	})

	it('has no section at all, and no sentence for it, when nothing is reported', () => {
		const model = usageSettingsModel({
			view: { providers: [{ provider: 'silent', label: 'Silent', kind: 'sign-in' }] },
			now: NOW,
		})
		expect(model.sections).toEqual([])
		expect(usageSettingsModel({ view: undefined, now: NOW }).sections).toEqual([])
	})
})

describe('a typed budget', () => {
	it('sets a positive number, clears on empty, and refuses anything else', () => {
		expect(parseBudgetDraft('25')).toEqual({ ok: true, usd: 25 })
		expect(parseBudgetDraft(' $12.5 ')).toEqual({ ok: true, usd: 12.5 })
		expect(parseBudgetDraft('')).toEqual({ ok: true, usd: undefined })
		for (const bad of ['0', '-3', 'abc', '1e12', 'Infinity'])
			expect(parseBudgetDraft(bad)).toEqual({ ok: false })
	})

	it('is stored where it always was, so a value set before the move is still read', () => {
		const store = new Map<string, string>()
		const storage = {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
		}
		// What the popover wrote before the budget moved to Settings.
		store.set('namzu.limit-budgets', JSON.stringify({ openai: 40 }))
		expect(readBudgets(storage)).toEqual({ openai: 40 })
		writeBudgets(storage, { openai: 40, deepseek: 5 })
		expect(JSON.parse(store.get('namzu.limit-budgets') ?? '')).toEqual({ openai: 40, deepseek: 5 })
	})
})
