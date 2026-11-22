import { VENDOR_RATES, resolveModelPricing } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import {
	OPENAI_FAST_TABLE,
	PLAN_MULTIPLIER,
	assertFastModeAccepted,
	isFirstPartyOpenAIEndpoint,
	resolveFastMode,
	servedSpeed,
	supportsFastMode,
} from '../fast-mode.js'

const api = (model: string, extra: Partial<Parameters<typeof resolveFastMode>[0]> = {}) =>
	resolveFastMode({ route: 'api', model, tier: 'fast', firstPartyEndpoint: true, ...extra })

describe('fast mode on the API route', () => {
	it('admits a listed model with the vendor multiple, per model', () => {
		expect(api('gpt-5.5')).toEqual({
			ok: true,
			tier: 'fast',
			wire: 'priority',
			rate: { kind: 'billing', multiplier: 2.5 },
		})
		expect(api('gpt-5.6-sol')).toMatchObject({ ok: true, rate: { multiplier: 2 } })
		expect(api('gpt-6.2-astra')).toMatchObject({ ok: true, rate: { multiplier: 2 } })
	})

	it('reads a dated snapshot as its model, in any letter case', () => {
		expect(api('gpt-5.4-2026-03-05')).toMatchObject({ ok: true })
		expect(api('GPT-5.6-Sol')).toMatchObject({ ok: true })
	})

	it('refuses an unlisted model, naming the list the table generates', () => {
		for (const model of ['gpt-4o', 'ft:gpt-5.4:acme::abc', 'gpt-5.5-pro']) {
			const verdict = api(model)
			expect(verdict.ok).toBe(false)
			if (verdict.ok) continue
			expect(verdict.reason).toContain(`Model "${model}" has no fast mode`)
			expect(verdict.reason).toContain('gpt-5.4, gpt-5.4-mini, gpt-5.5, gpt-5.6-sol')
			expect(verdict.reason).toContain('gpt-6, gpt-6.1 and gpt-6.2 models')
		}
	})

	it('refuses ultrafast, which Chat Completions cannot carry', () => {
		expect(api('gpt-6.2-sol', { tier: 'ultrafast' })).toEqual({
			ok: false,
			reason:
				'Ultrafast is offered through the OpenAI (Codex subscription) sign-in only. /fast turns on fast mode here.',
		})
	})

	it("refuses a host other than OpenAI's own, naming it", () => {
		expect(api('gpt-5.5', { firstPartyEndpoint: false, host: 'gw.example.com' })).toEqual({
			ok: false,
			reason:
				"Fast mode is offered on OpenAI's own endpoint only, and requests here go to gw.example.com.",
		})
	})

	it('agrees with the price catalogue on the multiple of every model it prices', () => {
		for (const [model, multiplier] of Object.entries(OPENAI_FAST_TABLE)) {
			const pricing = resolveModelPricing('openai', model)
			if (pricing === undefined) continue
			expect(pricing.fastMultiplier, model).toBe(multiplier)
		}
		const openai = VENDOR_RATES.find((vendor) => vendor.providerId === 'openai')
		for (const [model, pricing] of openai?.models ?? []) {
			if (pricing.fastMultiplier === undefined) continue
			expect(OPENAI_FAST_TABLE[model], model).toBe(pricing.fastMultiplier)
		}
	})
})

describe('fast mode on the subscription route', () => {
	const sub = (
		model: string,
		tier: 'fast' | 'ultrafast',
		advertised?: readonly ('fast' | 'ultrafast')[],
	) =>
		resolveFastMode({
			route: 'subscription',
			model,
			tier,
			firstPartyEndpoint: true,
			...(advertised ? { advertised } : {}),
		})

	it('admits only a tier the account listing offers', () => {
		expect(sub('gpt-6.2-sol', 'fast', ['fast', 'ultrafast'])).toEqual({
			ok: true,
			tier: 'fast',
			wire: 'priority',
			rate: { kind: 'plan', multiplier: 2 },
		})
		expect(sub('gpt-6.2-sol', 'ultrafast', ['fast', 'ultrafast'])).toEqual({
			ok: true,
			tier: 'ultrafast',
			wire: 'ultrafast',
			rate: { kind: 'plan', multiplier: 6 },
		})
		expect(sub('gpt-6-sol', 'ultrafast', ['fast'])).toEqual({
			ok: false,
			reason:
				'Your Codex subscription does not list Ultrafast for model "gpt-6-sol". It is offered on some plans and models only; /fast turns on fast mode instead.',
		})
		expect(sub('gpt-6-sol', 'fast', [])).toEqual({
			ok: false,
			reason:
				'Your Codex subscription does not list fast mode for model "gpt-6-sol". Pick another model with /model.',
		})
	})

	it('refuses while the listing has not answered', () => {
		expect(sub('gpt-6.2-sol', 'fast')).toEqual({
			ok: false,
			reason:
				'Fast mode needs your Codex model list, which has not loaded yet. Try /fast again in a moment.',
		})
	})

	it('states a plan multiple only where a source does, and never invents one', () => {
		expect(sub('gpt-5.6-sol', 'fast', ['fast'])).toEqual({
			ok: true,
			tier: 'fast',
			wire: 'priority',
			rate: { kind: 'plan' },
		})
		expect(PLAN_MULTIPLIER.ultrafast['gpt-6-astra']).toBe(8)
		expect(PLAN_MULTIPLIER.fast['gpt-6.1-terra']).toBe(2.5)
	})
})

describe('the refusal before transport', () => {
	it('throws a bad_request with the driver code, and the routing header only on the subscription', () => {
		expect(() =>
			assertFastModeAccepted({
				route: 'api',
				model: 'gpt-4o',
				tier: 'fast',
				firstPartyEndpoint: true,
			}),
		).toThrowError(
			expect.objectContaining({ providerCode: 'fast_mode_unsupported', kind: 'bad_request' }),
		)
		expect(
			assertFastModeAccepted({
				route: 'api',
				model: 'gpt-5.5',
				tier: 'fast',
				firstPartyEndpoint: true,
			}),
		).toEqual({ wire: 'priority' })
		expect(
			assertFastModeAccepted({
				route: 'subscription',
				model: 'gpt-6.2-sol',
				tier: 'ultrafast',
				advertised: ['ultrafast'],
				firstPartyEndpoint: true,
			}),
		).toEqual({
			wire: 'ultrafast',
			header: { 'x-codex-routing-hint': 'model=gpt-6.2-sol;tier=ultrafast' },
		})
	})

	it('answers supportsFastMode with the same verdict', () => {
		expect(
			supportsFastMode({ route: 'api', model: 'gpt-5.5', tier: 'fast', firstPartyEndpoint: true }),
		).toBe(true)
		expect(
			supportsFastMode({ route: 'api', model: 'gpt-4o', tier: 'fast', firstPartyEndpoint: true }),
		).toBe(false)
	})
})

describe('the endpoint check', () => {
	it("is true for OpenAI's own host and for no URL, false for another", () => {
		expect(isFirstPartyOpenAIEndpoint(undefined)).toBe(true)
		expect(isFirstPartyOpenAIEndpoint('https://api.openai.com/v1')).toBe(true)
		expect(isFirstPartyOpenAIEndpoint('https://gw.example.com/v1')).toBe(false)
	})
})

describe('reading back the served tier', () => {
	it('maps priority and fast to fast, ultrafast to ultrafast, and leaves serviceTier alone for them', () => {
		expect(servedSpeed('priority', undefined)).toEqual({ speed: 'fast' })
		expect(servedSpeed('fast', undefined)).toEqual({ speed: 'fast' })
		expect(servedSpeed('ultrafast', 'fast')).toEqual({ speed: 'ultrafast' })
	})

	it('reads default and auto as standard even when fast was asked for', () => {
		expect(servedSpeed('default', 'fast')).toEqual({})
		expect(servedSpeed('auto', 'fast')).toEqual({})
	})

	it('prices an unreported tier as the one requested, and carries flex and scale as they are', () => {
		expect(servedSpeed(undefined, 'fast')).toEqual({ speed: 'fast' })
		expect(servedSpeed(null, undefined)).toEqual({})
		expect(servedSpeed('flex', 'fast')).toEqual({ serviceTier: 'flex' })
		expect(servedSpeed('scale', undefined)).toEqual({ serviceTier: 'scale' })
	})
})
