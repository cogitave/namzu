import { describe, expect, it } from 'vitest'

import { fitStatusLine } from './StatusBar.js'
import {
	fastAfterModelChange,
	fastDroppedMessage,
	fastLaunchRefusal,
	fastModeBlocker,
	fastModeVerdict,
	fastOffMessage,
	fastOnMessage,
	launchFastOutcome,
	rateWords,
	requestedFastTier,
} from './fast-mode.js'

const BEFORE = Date.UTC(2026, 10, 29)
const AFTER = Date.UTC(2026, 10, 30)
const onClaude = (model: string | null, now = BEFORE, otherHost: string | null = null) =>
	fastModeBlocker('anthropic', model, { now, otherHost })

describe('what /fast and --fast ask of an Anthropic model', () => {
	it('accepts a model the vendor documents it on', async () => {
		expect(await onClaude('claude-opus-5-5')).toBeUndefined()
		expect(await onClaude('claude-fable-5-2')).toBeUndefined()
	})

	it('refuses a custom or compatible endpoint, naming the host', async () => {
		const reason = await onClaude('claude-opus-5-5', BEFORE, 'gw.example.com')
		expect(reason).toContain('gw.example.com')
		expect(reason).toContain('own endpoint')
	})

	it('refuses an Anthropic model without it, naming where it exists', async () => {
		expect(await onClaude('claude-sonnet-5-5')).toContain('Opus 5.5')
		expect(await onClaude(null)).toContain('needs a model')
	})

	it('stops offering opus 4.8 on its removal date and names the replacement', async () => {
		expect(await onClaude('claude-opus-4-8')).toBeUndefined()
		expect(await onClaude('claude-opus-4-8', AFTER)).toContain('claude-opus-5-5')
	})

	it('has no faster tier', async () => {
		expect(
			await fastModeBlocker('anthropic', 'claude-opus-5-5', {
				now: BEFORE,
				otherHost: null,
				tier: 'ultrafast',
			}),
		).toBe('Ultrafast is not offered on Anthropic models. /fast turns on fast mode.')
	})
})

describe('what /fast and --fast ask of an OpenAI model on an API key', () => {
	const onApiKey = (
		model: string | null,
		extra: { otherHost?: string | null; tier?: 'fast' | 'ultrafast' } = {},
	) => fastModeBlocker('openai', model, { otherHost: null, ...extra })

	it('accepts a listed model', async () => {
		expect(await onApiKey('gpt-5.5')).toBeUndefined()
		expect(await onApiKey('gpt-6.2-sol')).toBeUndefined()
	})

	it('refuses an unlisted model and names the list', async () => {
		const reason = await onApiKey('gpt-4o')
		expect(reason).toContain('Model "gpt-4o" has no fast mode')
		expect(reason).toContain('gpt-5.4, gpt-5.4-mini, gpt-5.5')
	})

	it('needs a model', async () => {
		expect(await onApiKey(null)).toBe('Fast mode needs a model; pick one with /model.')
	})

	it('refuses ultrafast on an API key', async () => {
		expect(await onApiKey('gpt-6.2-sol', { tier: 'ultrafast' })).toContain('Codex subscription')
	})

	it('refuses a custom endpoint, naming the host', async () => {
		expect(await onApiKey('gpt-5.5', { otherHost: 'gw.example.com' })).toBe(
			"Fast mode is offered on OpenAI's own endpoint only, and requests here go to gw.example.com.",
		)
	})
})

describe('what /fast and --fast ask of the Codex subscription', () => {
	it('waits for the model list and then admits only what the account lists', async () => {
		expect(await fastModeBlocker('codex', 'gpt-6.2-sol')).toContain('has not loaded yet')
		expect(await fastModeBlocker('codex', 'gpt-6.2-sol', { advertised: ['fast'] })).toBeUndefined()
		expect(
			await fastModeBlocker('codex', 'gpt-6.2-sol', { advertised: [], tier: 'fast' }),
		).toContain('does not list fast mode for model "gpt-6.2-sol"')
		expect(
			await fastModeBlocker('codex', 'gpt-6.2-sol', { advertised: ['fast'], tier: 'ultrafast' }),
		).toContain('does not list Ultrafast')
		expect(
			await fastModeBlocker('codex', 'gpt-6.2-sol', {
				advertised: ['fast', 'ultrafast'],
				tier: 'ultrafast',
			}),
		).toBeUndefined()
	})

	it('turns fast mode off, with the reason, when a model that only lists fast replaces an ultrafast one', async () => {
		const verdict = await fastModeVerdict('codex', 'gpt-6-sol', {
			tier: 'ultrafast',
			advertised: ['fast'],
		})
		expect(verdict.ok).toBe(false)
		if (verdict.ok) return
		expect(fastDroppedMessage(verdict.reason)).toBe(
			'Fast mode turned off: Your Codex subscription does not list Ultrafast for model "gpt-6-sol". It is offered on some plans and models only; /fast turns on fast mode instead.',
		)
	})
})

describe('other providers', () => {
	it('are refused with the words that name both supported vendors', async () => {
		const words =
			'Fast mode is available on Anthropic and OpenAI models only. Pick one with /model.'
		expect(await fastModeBlocker('google', 'gemini-x')).toBe(words)
		expect(await fastModeBlocker(undefined, 'claude-opus-5-5')).toBe(words)
	})
})

describe('what turning it on says', () => {
	const ok = async (
		provider: string,
		model: string,
		options: Parameters<typeof fastModeVerdict>[2],
	) => {
		const verdict = await fastModeVerdict(provider, model, options)
		if (!verdict.ok) throw new Error(verdict.reason)
		return verdict
	}

	it('keeps the Anthropic words as they were', async () => {
		const verdict = await ok('anthropic', 'claude-opus-5-5', { now: BEFORE, otherHost: null })
		expect(fastOnMessage(verdict)).toBe(fastOnMessage())
		expect(fastOnMessage()).toBe(
			'Fast mode on: faster replies, billed at twice the standard rate. /fast turns it off.',
		)
	})

	it('names the multiple on an API key', async () => {
		expect(fastOnMessage(await ok('openai', 'gpt-5.6-sol', { otherHost: null }))).toBe(
			'Fast mode on: faster replies, billed at twice the standard rate. /fast turns it off.',
		)
		expect(fastOnMessage(await ok('openai', 'gpt-5.5', { otherHost: null }))).toBe(
			'Fast mode on: faster replies, billed at 2.5 times the standard rate. /fast turns it off.',
		)
	})

	it('names the plan multiple only when a source states it', async () => {
		expect(fastOnMessage(await ok('codex', 'gpt-6.2-sol', { advertised: ['fast'] }))).toBe(
			'Fast mode on: faster replies, using your plan allowance 2x as fast. /fast turns it off.',
		)
		expect(fastOnMessage(await ok('codex', 'gpt-5.6-sol', { advertised: ['fast'] }))).toBe(
			'Fast mode on: faster replies, using more of your plan allowance. /fast turns it off.',
		)
		expect(
			fastOnMessage(
				await ok('codex', 'gpt-6.2-sol', { advertised: ['ultrafast'], tier: 'ultrafast' }),
			),
		).toBe(
			'Ultrafast on: the fastest replies, using your plan allowance 6x as fast. /ultrafast turns it off.',
		)
		expect(
			fastOnMessage(
				await ok('codex', 'gpt-5.6-sol', { advertised: ['ultrafast'], tier: 'ultrafast' }),
			),
		).toBe(
			'Ultrafast on: the fastest replies, using much more of your plan allowance. /ultrafast turns it off.',
		)
	})

	it('says a launch refusal the way it did, and the rate in plain words', () => {
		expect(fastLaunchRefusal('No.')).toBe(
			'--fast was not applied: No. Continuing at standard speed.',
		)
		expect(rateWords(2)).toBe('twice')
		expect(rateWords(2.5)).toBe('2.5 times')
	})
})

describe('the toggle', () => {
	const tiers = [undefined, 'fast', 'ultrafast'] as const
	it('toggles the command own tier, from every state', () => {
		for (const current of tiers) {
			expect(requestedFastTier(current, 'fast')).toBe(current === 'fast' ? undefined : 'fast')
			expect(requestedFastTier(current, 'ultrafast')).toBe(
				current === 'ultrafast' ? undefined : 'ultrafast',
			)
		}
	})

	it('names the tier that ended', () => {
		expect(fastOffMessage()).toBe('Fast mode off: standard speed and rate.')
		expect(fastOffMessage('fast')).toBe('Fast mode off: standard speed and rate.')
		expect(fastOffMessage('ultrafast')).toBe('Ultrafast off: standard speed and rate.')
	})
})

describe('the footer', () => {
	const base = {
		columns: 80,
		provider: null,
		model: 'claude-opus-5-5',
		effort: 'high',
		interrupt: null,
		modeLabel: '',
	}

	it('shows fast or ultrafast only when it is on', () => {
		expect(fitStatusLine({ ...base, fast: true }).fast).toBe('fast')
		expect(fitStatusLine({ ...base, fast: 'fast' }).fast).toBe('fast')
		expect(fitStatusLine({ ...base, fast: 'ultrafast' }).fast).toBe('ultrafast')
		expect(fitStatusLine({ ...base, fast: false }).fast).toBeNull()
		expect(fitStatusLine(base).fast).toBeNull()
	})

	it('goes before the effort label on a narrow line', () => {
		const roomy = fitStatusLine({ ...base, columns: 40, fast: true })
		expect(roomy.effort).toBe('effort high')
		const tight = fitStatusLine({ ...base, columns: 15, model: null, fast: 'ultrafast' })
		expect(tight.fast === null && tight.effort !== null).toBe(true)
	})
})

describe('applying a launch request to the opened session', () => {
	it('starts fast and says what it costs once, for a saved setting and for --fast', async () => {
		const session = { providerId: 'openai', modelSummary: 'gpt-5.5' }
		for (const source of ['saved', 'flag'] as const) {
			const outcome = await launchFastOutcome(session, source)
			expect(outcome.tier).toBe('fast')
			expect(outcome.message).toBe(
				'Fast mode on: faster replies, billed at 2.5 times the standard rate. /fast turns it off.',
			)
		}
	})

	it('starts at standard speed and says why when the model cannot take it', async () => {
		const outcome = await launchFastOutcome(
			{ providerId: 'openai', modelSummary: 'gpt-4o' },
			'saved',
		)
		expect(outcome.tier).toBeUndefined()
		expect(outcome.message).toContain('The saved fast mode setting was not applied')
		expect(outcome.message).toContain('Continuing at standard speed.')
	})

	it('on the subscription, starts fast only when the account listing offers it', async () => {
		const listed = {
			providerId: 'codex',
			modelSummary: 'gpt-6.2-sol',
			speedTiersFor: () => ['fast', 'ultrafast'] as const,
		}
		expect((await launchFastOutcome(listed, 'flag')).tier).toBe('fast')
		const none = { ...listed, speedTiersFor: () => [] as const }
		expect((await launchFastOutcome(none, 'flag')).tier).toBeUndefined()
	})

	it('keeps the mode across a model change that offers the tier, and ends it with a line otherwise', async () => {
		const offers = {
			providerId: 'codex',
			modelSummary: 'gpt-6.2-sol',
			speedTiersFor: () => ['fast', 'ultrafast'] as const,
		}
		expect(await fastAfterModelChange(offers, 'ultrafast')).toBeUndefined()
		const fastOnly = { ...offers, speedTiersFor: () => ['fast'] as const }
		expect(await fastAfterModelChange(fastOnly, 'ultrafast')).toMatch(/^Fast mode turned off: /u)
		expect(await fastAfterModelChange({ providerId: 'zen', modelSummary: 'm' }, 'fast')).toMatch(
			/^Fast mode turned off: /u,
		)
	})
})
