import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	AzureFoundryDecisionModel,
	DecisionError,
	HttpDecisionModel,
	forgetCriteriaForms,
	readableServiceText,
	refusesQuestionField,
} from '../index.js'

type Behaviour =
	| 'takes-object'
	| 'takes-no-criteria'
	| 'refuses-all'
	| 'bad-state'
	| 'bad-state-issue'

/** The body a validating service answered with for a string `criteria`. */
const SYMPTOM = JSON.stringify(
	[
		{
			expected: 'object',
			code: 'invalid_type',
			path: ['questions', 'q', 'criteria'],
			message: 'Invalid input: expected object, received string',
		},
	],
	null,
	2,
)

interface Fake {
	url: string
	requests: Record<string, any>[]
	close: () => Promise<void>
}

const open: Fake[] = []

async function fake(behaviour: Behaviour, status = 200): Promise<Fake> {
	const requests: Record<string, any>[] = []
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on('data', (c: Buffer) => chunks.push(c))
		req.on('end', () => {
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
			requests.push(body)
			const q = body.questions.q
			const reply = (code: number, message: string) => {
				res.writeHead(code, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ error: { code, message } }))
			}
			if (status !== 200) return reply(status, 'nope')
			if (behaviour === 'bad-state') return reply(400, 'state must not be empty')
			if (behaviour === 'bad-state-issue') {
				return reply(
					400,
					JSON.stringify([
						{
							code: 'too_small',
							path: ['state'],
							message: 'state is required and the criteria are not the problem',
						},
					]),
				)
			}
			if (behaviour === 'refuses-all') {
				if (q.type === 'noul' && q.criteria !== undefined) return reply(400, SYMPTOM)
				return reply(
					400,
					JSON.stringify([
						{
							code: 'invalid_type',
							path: ['questions', 'q', 'instructions'],
							message: 'Invalid input',
						},
					]),
				)
			}
			const c = q.criteria
			const refused =
				c !== undefined &&
				q.type === 'noul' &&
				(typeof c === 'string' || (typeof c === 'object' && behaviour === 'takes-no-criteria'))
			if (refused) return reply(400, SYMPTOM)
			res.writeHead(200, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({ answers: { q: { noul: 0.8, type: 'noul' } } }))
		})
	})
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
	const f: Fake = {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/decisions`,
		requests,
		close: () => new Promise<void>((r) => server.close(() => r())),
	}
	open.push(f)
	return f
}

beforeEach(() => forgetCriteriaForms())

afterEach(async () => {
	await Promise.all(open.splice(0).map((f) => f.close()))
})

const CRITERIA = 'Yes when the text is a short plain word.'

/** No yes/no question in any test carries a string in `criteria`. */
const noStringCriteria = (f: Fake) =>
	expect(f.requests.some((r) => typeof r.questions.q.criteria === 'string')).toBe(false)

describe('yes/no criteria', () => {
	it('a strict service gets one request on the first call, with the published object', async () => {
		const f = await fake('takes-object')
		const model = new HttpDecisionModel({ url: f.url })
		expect(await model.yesno('s', 'is it?', { criteria: CRITERIA })).toEqual({ p: 0.8 })
		expect(f.requests).toHaveLength(1)
		expect(f.requests[0]?.questions.q).toEqual({
			type: 'noul',
			instructions: 'is it?',
			criteria: { true: CRITERIA },
		})
		await model.yesno('s', 'is it?', { criteria: CRITERIA })
		expect(f.requests).toHaveLength(2)
		noStringCriteria(f)
	})

	it('a service that refuses the object gets two requests, then one, with a labelled fold', async () => {
		const f = await fake('takes-no-criteria')
		const model = new HttpDecisionModel({ url: f.url })
		expect(await model.yesno('s', 'is it?', { criteria: CRITERIA })).toEqual({ p: 0.8 })
		expect(f.requests).toHaveLength(2)
		const folded = f.requests[1]?.questions.q
		expect(folded.criteria).toBeUndefined()
		expect(folded.instructions).toBe(`is it?\n\nThe answer is yes when: ${CRITERIA}`)

		await model.yesno('s', 'is it?', { criteria: CRITERIA })
		expect(f.requests).toHaveLength(3)
		expect(f.requests[2]?.questions.q.instructions).toContain(CRITERIA)
		expect(f.requests[2]?.questions.q.criteria).toBeUndefined()
		noStringCriteria(f)
	})

	it('a new model object for the same service remembers what was learnt', async () => {
		const f = await fake('takes-no-criteria')
		await new HttpDecisionModel({ url: f.url }).yesno('s', 'i', { criteria: CRITERIA })
		await new HttpDecisionModel({ url: f.url }).yesno('s', 'i', { criteria: CRITERIA })
		expect(f.requests).toHaveLength(3)
	})

	it('choice and score are sent as before, also after a yes/no learnt the fold', async () => {
		const f = await fake('takes-no-criteria')
		const model = new HttpDecisionModel({ url: f.url })
		await model.yesno('s', 'i', { criteria: CRITERIA })
		const before = f.requests.length
		await model.choice('s', 'pick', ['a', 'b']).catch(() => undefined)
		await model.score('s', 'rate', ['low', 'high']).catch(() => undefined)
		expect(f.requests[before]?.questions.q).toEqual({
			type: 'choice',
			instructions: 'pick',
			criteria: { a: null, b: null },
		})
		expect(f.requests[before + 1]?.questions.q).toEqual({
			type: 'score',
			instructions: 'rate',
			criteria: ['low', 'high'],
		})
		expect(f.requests).toHaveLength(before + 2)
	})

	it('a model that refuses the folded form too fails with the shape error', async () => {
		const f = await fake('refuses-all')
		const model = new HttpDecisionModel({ url: f.url })
		const error = await model.yesno('s', 'i', { criteria: CRITERIA }).catch((e) => e)
		expect(error).toBeInstanceOf(DecisionError)
		expect((error as DecisionError).status).toBe(400)
		expect(refusesQuestionField(error, ['instructions', 'criteria'])).toBe(true)
		expect(readableServiceText((error as DecisionError).message)).toBe(
			'questions.q.instructions: Invalid input',
		)
		expect(f.requests).toHaveLength(2)
	})

	it('a 400 for another reason is not retried', async () => {
		const f = await fake('bad-state')
		const error = await new HttpDecisionModel({ url: f.url })
			.yesno('s', 'i', { criteria: CRITERIA })
			.catch((e) => e)
		expect((error as DecisionError).message).toBe('state must not be empty')
		expect(f.requests).toHaveLength(1)
	})

	it('a 400 whose only issue path is state is not retried, whatever its words say', async () => {
		const f = await fake('bad-state-issue')
		const error = await new HttpDecisionModel({ url: f.url })
			.yesno('s', 'i', { criteria: CRITERIA })
			.catch((e) => e)
		expect(error).toBeInstanceOf(DecisionError)
		expect(f.requests).toHaveLength(1)
		expect(refusesQuestionField(error, ['criteria'])).toBe(false)
	})

	it('a 401 and a 404 are not retried', async () => {
		for (const status of [401, 404]) {
			const f = await fake('takes-object', status)
			const error = await new HttpDecisionModel({ url: f.url })
				.yesno('s', 'i', { criteria: CRITERIA })
				.catch((e) => e)
			expect((error as DecisionError).status).toBe(status)
			expect(f.requests).toHaveLength(1)
		}
	})

	it('a yes/no without criteria is one request in the old shape', async () => {
		const f = await fake('takes-no-criteria')
		await new HttpDecisionModel({ url: f.url }).yesno('s', 'i')
		expect(f.requests).toHaveLength(1)
		expect(f.requests[0]?.questions.q).toEqual({ type: 'noul', instructions: 'i' })
	})

	it('the other driver sends the object first and falls back the same way', async () => {
		const sent: Record<string, any>[] = []
		const strict = (async (_u: string, init: RequestInit) => {
			sent.push(JSON.parse(String(init.body)))
			return new Response(JSON.stringify({ answers: { q: { noul: 0.7 } } }), { status: 200 })
		}) as unknown as typeof fetch
		const make = (f: typeof fetch, deployment: string) =>
			new AzureFoundryDecisionModel({
				endpoint: 'https://res.example.test',
				deployment,
				getApiKey: () => 'k',
				fetch: f,
			})
		await make(strict, 'strict').yesno('s', 'is it?', { criteria: CRITERIA })
		expect(sent).toHaveLength(1)
		expect(sent[0]?.questions.q).toEqual({
			type: 'noul',
			instructions: 'is it?',
			criteria: { true: CRITERIA },
		})

		const seen: Record<string, any>[] = []
		const refusing = (async (_u: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body))
			seen.push(body)
			return body.questions.q.criteria !== undefined
				? new Response(JSON.stringify({ error: { code: 400, message: SYMPTOM } }), { status: 400 })
				: new Response(JSON.stringify({ answers: { q: { noul: 0.7 } } }), { status: 200 })
		}) as unknown as typeof fetch
		const m = make(refusing, 'refusing')
		await m.yesno('s', 'is it?', { criteria: CRITERIA })
		expect(seen).toHaveLength(2)
		expect(seen[1]?.questions.q).toEqual({
			type: 'noul',
			instructions: `is it?\n\nThe answer is yes when: ${CRITERIA}`,
		})
		await m.yesno('s', 'is it?', { criteria: CRITERIA })
		expect(seen).toHaveLength(3)
		// Without criteria and for choice, nothing changes.
		await m.yesno('s', 'is it?')
		expect(seen[3]?.questions.q).toEqual({ type: 'noul', instructions: 'is it?' })
		await m.choice('s', 'pick', ['a', 'b']).catch(() => undefined)
		expect(seen[4]?.questions.q).toEqual({
			type: 'choice',
			instructions: 'pick',
			criteria: { a: null, b: null },
		})
	})
})

describe('readableServiceText', () => {
	it('turns a validator dump into path and message', () => {
		expect(readableServiceText(SYMPTOM)).toBe(
			'questions.q.criteria: Invalid input: expected object, received string',
		)
		expect(readableServiceText('plain words')).toBe('plain words')
	})
})
