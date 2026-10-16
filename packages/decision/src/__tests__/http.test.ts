import { describe, expect, it } from 'vitest'
import { DecisionError, HttpDecisionModel } from '../index.js'

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

describe('HttpDecisionModel', () => {
	it('yesno posts the systemone shape to the configured url and returns p', async () => {
		const { calls, f } = fake(200, { answers: { q: { noul: 0.42, type: 'noul' } } })
		const model = new HttpDecisionModel({ url: 'http://localhost:8080/decisions', fetch: f })
		const r = await model.yesno('state', 'is it?')
		expect(r).toEqual({ p: 0.42 })
		const c = calls[0]!
		expect(c.url).toBe('http://localhost:8080/decisions')
		expect(c.body.state).toBe('state')
		expect(c.body.questions.q).toEqual({ type: 'noul', instructions: 'is it?' })
		// Keyless by default: no Authorization header.
		expect((c.init.headers as Record<string, string>).Authorization).toBeUndefined()
	})

	it('sends the model field and a bearer token when configured', async () => {
		const { calls, f } = fake(200, { answers: { q: { noul: 0.5, type: 'noul' } } })
		const model = new HttpDecisionModel({
			url: 'http://host/decisions',
			model: 'laya-1',
			apiKey: 'k-1',
			headers: { 'x-trace': 't' },
			fetch: f,
		})
		await model.yesno('s', 'q')
		const c = calls[0]!
		expect(c.body.model).toBe('laya-1')
		expect((c.init.headers as Record<string, string>).Authorization).toBe('Bearer k-1')
		expect((c.init.headers as Record<string, string>)['x-trace']).toBe('t')
	})

	it('choice and score map their answers', async () => {
		const choice = fake(200, {
			answers: { q: { choice: { option: 'b', probabilities: { a: 0.3, b: 0.7 } } } },
		})
		const cModel = new HttpDecisionModel({ url: 'http://h/d', fetch: choice.f })
		expect(await cModel.choice('s', 'pick', ['a', 'b'])).toEqual({
			option: 'b',
			probabilities: { a: 0.3, b: 0.7 },
		})
		expect(choice.calls[0]!.body.questions.q.options).toEqual(['a', 'b'])

		const score = fake(200, { answers: { q: { score: { level: 0, probabilities: [0.9, 0.1] } } } })
		const sModel = new HttpDecisionModel({ url: 'http://h/d', fetch: score.f })
		expect(await sModel.score('s', 'rate', ['lo', 'hi'])).toEqual({
			level: 0,
			probabilities: [0.9, 0.1],
		})
		expect(score.calls[0]!.body.questions.q.levels).toEqual(['lo', 'hi'])
	})

	it('throws DecisionError with status and code on a non-2xx', async () => {
		const { f } = fake(503, { error: { code: 'unavailable', message: 'server down' } })
		const model = new HttpDecisionModel({ url: 'http://h/d', fetch: f })
		const err = await model.yesno('s', 'q').catch((e: unknown) => e)
		expect(err).toBeInstanceOf(DecisionError)
		expect(err).toMatchObject({ status: 503, code: 'unavailable', message: 'server down' })
	})

	it('threads the abort signal into fetch', async () => {
		const { calls, f } = fake(200, { answers: { q: { noul: 0.5, type: 'noul' } } })
		const ac = new AbortController()
		await new HttpDecisionModel({ url: 'http://h/d', fetch: f }).yesno('s', 'q', {
			signal: ac.signal,
		})
		expect(calls[0]!.init.signal).toBe(ac.signal)
	})
})
