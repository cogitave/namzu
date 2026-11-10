import { describe, expect, it } from 'vitest'
import { AzureFoundryDecisionModel, DecisionError } from '../index.js'

interface Call {
	url: string
	init: RequestInit
	body: any
}

function fake(status: number, payload: unknown) {
	const calls: Call[] = []
	const f = (async (url: string, init: RequestInit) => {
		calls.push({ url: String(url), init, body: JSON.parse(String(init.body)) })
		return new Response(JSON.stringify(payload), { status })
	}) as unknown as typeof fetch
	return { calls, f }
}

function model(f: typeof fetch, getToken = async () => 'tok-1') {
	return new AzureFoundryDecisionModel({
		endpoint: 'https://res.services.ai.azure.com/',
		deployment: 'decision-1',
		getToken,
		fetch: f,
	})
}

describe('AzureFoundryDecisionModel', () => {
	it('yesno leaves criteria out of the request whether or not one is given', async () => {
		const { calls, f } = fake(200, { answers: { q: { noul: 0.5, type: 'noul' } } })
		await model(f).yesno('s', 'is it?', { criteria: 'Yes when it is.' })
		expect(calls[0]?.body.questions.q).toEqual({ type: 'noul', instructions: 'is it?' })
	})

	it('yesno posts a noul question and returns p', async () => {
		const { calls, f } = fake(200, { answers: { q: { noul: 0.97, type: 'noul' } } })
		const r = await model(f).yesno('state', 'is it?')
		expect(r).toEqual({ p: 0.97 })
		const c = calls[0]!
		expect(c.url).toBe('https://res.services.ai.azure.com/providers/microsoft/v1/systemone')
		expect(c.body.model).toBe('decision-1')
		expect(c.body.state).toBe('state')
		expect(c.body.questions.q).toEqual({ type: 'noul', instructions: 'is it?' })
		expect((c.init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
	})

	// The answers below are responses captured from the live service.
	it('choice sends the options as criteria keys and maps the answer', async () => {
		const { calls, f } = fake(200, {
			answers: {
				q: {
					choice: 'settings',
					confidence: 0.9988,
					probabilities: { home: 0.0005, profile: 0.0003, settings: 0.9992 },
					type: 'choice',
				},
			},
		})
		const r = await model(f).choice('s', 'which page?', ['settings', 'profile', 'home'])
		expect(calls[0]?.body.questions.q).toEqual({
			type: 'choice',
			instructions: 'which page?',
			criteria: { settings: null, profile: null, home: null },
		})
		expect(r).toEqual({
			option: 'settings',
			confidence: 0.9988,
			probabilities: { home: 0.0005, profile: 0.0003, settings: 0.9992 },
		})
	})

	it('choice falls back to the most probable option when the answer names none', async () => {
		const { f } = fake(200, { answers: { q: { probabilities: { a: 0.2, b: 0.8 } } } })
		expect((await model(f).choice('s', 'pick', ['a', 'b'])).option).toBe('b')
	})

	it('score sends the scale as criteria and maps an index-keyed distribution', async () => {
		const { calls, f } = fake(200, {
			answers: {
				q: {
					confidence: 0.994,
					legend: { '0': 'Cosmetic', '1': 'Minor', '2': 'Major', '3': 'Critical' },
					probabilities: { '0': 0.0001, '1': 0.0002, '2': 0.004, '3': 0.9957 },
					score: 2.995,
					type: 'score',
				},
			},
		})
		const r = await model(f).score('s', 'how severe?', ['Cosmetic', 'Minor', 'Major', 'Critical'])
		expect(calls[0]?.body.questions.q).toEqual({
			type: 'score',
			instructions: 'how severe?',
			criteria: ['Cosmetic', 'Minor', 'Major', 'Critical'],
		})
		expect(r).toEqual({
			level: 3,
			probabilities: [0.0001, 0.0002, 0.004, 0.9957],
			score: 2.995,
			confidence: 0.994,
		})
	})

	it('sends an API key as api-key, instead of a bearer token, and reads it at each call', async () => {
		const { calls, f } = fake(200, { answers: { q: { noul: 0.5, type: 'noul' } } })
		let key = 'key-1'
		const m = new AzureFoundryDecisionModel({
			endpoint: 'https://res.services.ai.azure.com',
			deployment: 'decision-1',
			getApiKey: () => key,
			getToken: async () => 'tok-ignored',
			fetch: f,
		})
		await m.yesno('s', 'q')
		key = 'key-2'
		await m.yesno('s', 'q')
		const headers = (i: number) => calls[i]?.init.headers as Record<string, string>
		expect(headers(0)['api-key']).toBe('key-1')
		expect(headers(1)['api-key']).toBe('key-2')
		expect(headers(0).Authorization).toBeUndefined()
	})

	it('refuses to call with neither a token nor a key', async () => {
		const { f } = fake(200, {})
		const m = new AzureFoundryDecisionModel({
			endpoint: 'https://res.services.ai.azure.com',
			deployment: 'decision-1',
			fetch: f,
		})
		await expect(m.yesno('s', 'q')).rejects.toThrow(/getToken or getApiKey/)
	})

	it('throws DecisionError with status and code on a non-2xx', async () => {
		const { f } = fake(400, {
			error: { code: 'unsupported_request_argument', message: 'bad argument' },
		})
		const err = await model(f)
			.yesno('s', 'q')
			.catch((e: unknown) => e)
		expect(err).toBeInstanceOf(DecisionError)
		expect(err).toMatchObject({
			status: 400,
			code: 'unsupported_request_argument',
			message: 'bad argument',
		})
	})

	it('awaits getToken and uses its value', async () => {
		const { calls, f } = fake(200, { answers: { q: { noul: 0.5, type: 'noul' } } })
		await model(f, async () => 'fresh-token').yesno('s', 'q')
		expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
			'Bearer fresh-token',
		)
	})

	it('threads the abort signal into fetch', async () => {
		const { calls, f } = fake(200, { answers: { q: { noul: 0.5, type: 'noul' } } })
		const ac = new AbortController()
		await model(f).yesno('s', 'q', { signal: ac.signal })
		expect(calls[0]!.init.signal).toBe(ac.signal)
	})
})
