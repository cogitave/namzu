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

	it('choice sends options and maps the answer', async () => {
		const { calls, f } = fake(200, {
			answers: { q: { choice: { option: 'e4', probabilities: { e1: 0.1, e4: 0.9 } } } },
		})
		const r = await model(f).choice('s', 'pick', ['e1', 'e4'])
		expect(calls[0]!.body.questions.q.type).toBe('choice')
		expect(calls[0]!.body.questions.q.options).toEqual(['e1', 'e4'])
		expect(r).toEqual({ option: 'e4', probabilities: { e1: 0.1, e4: 0.9 } })
	})

	it('score sends levels and maps the answer', async () => {
		const { calls, f } = fake(200, {
			answers: { q: { score: { level: 1, probabilities: [0.2, 0.8] } } },
		})
		const r = await model(f).score('s', 'rate', ['bad', 'good'])
		expect(calls[0]!.body.questions.q.type).toBe('score')
		expect(calls[0]!.body.questions.q.levels).toEqual(['bad', 'good'])
		expect(r).toEqual({ level: 1, probabilities: [0.2, 0.8] })
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
