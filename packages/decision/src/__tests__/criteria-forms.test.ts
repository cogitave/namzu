import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	DecisionError,
	HttpDecisionModel,
	forgetCriteriaForms,
	readableServiceText,
	refusesQuestionField,
} from '../index.js'

type Behaviour = 'takes-text' | 'takes-object' | 'takes-no-criteria' | 'refuses-all' | 'bad-state'

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
			if (behaviour === 'refuses-all') {
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
				((typeof c === 'string' && behaviour !== 'takes-text') ||
					(typeof c === 'object' && behaviour === 'takes-no-criteria'))
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

describe('yes/no criteria a service refuses', () => {
	it('a service that takes text gets one request with the criteria as before', async () => {
		const f = await fake('takes-text')
		const model = new HttpDecisionModel({ url: f.url })
		expect(await model.yesno('s', 'is it?', { criteria: CRITERIA })).toEqual({
			p: 0.8,
		})
		expect(f.requests).toHaveLength(1)
		expect(f.requests[0]?.questions.q).toEqual({
			type: 'noul',
			instructions: 'is it?',
			criteria: CRITERIA,
		})
	})

	it('a service that wants an object is asked once more with the published object, then straight', async () => {
		const f = await fake('takes-object')
		const model = new HttpDecisionModel({ url: f.url })
		expect(await model.yesno('s', 'is it?', { criteria: CRITERIA })).toEqual({
			p: 0.8,
		})
		expect(f.requests).toHaveLength(2)
		expect(f.requests[1]?.questions.q).toEqual({
			type: 'noul',
			instructions: 'is it?',
			criteria: { true: CRITERIA },
		})
		expect(await model.yesno('s', 'is it?', { criteria: CRITERIA })).toEqual({
			p: 0.8,
		})
		expect(f.requests).toHaveLength(3)
		expect(f.requests[2]?.questions.q.criteria).toEqual({ true: CRITERIA })
	})

	it('a service that takes no criteria gets the text folded into the instructions, once', async () => {
		const f = await fake('takes-no-criteria')
		const model = new HttpDecisionModel({ url: f.url })
		expect(await model.yesno('s', 'is it?', { criteria: CRITERIA })).toEqual({
			p: 0.8,
		})
		expect(f.requests).toHaveLength(3)
		const folded = f.requests[2]?.questions.q
		expect(folded.criteria).toBeUndefined()
		expect(folded.instructions).toContain('is it?')
		expect(folded.instructions).toContain(CRITERIA)

		expect(await model.yesno('s', 'is it?', { criteria: CRITERIA })).toEqual({
			p: 0.8,
		})
		expect(f.requests).toHaveLength(4)
		expect(f.requests[3]?.questions.q.instructions).toContain(CRITERIA)
		expect(f.requests[3]?.questions.q.criteria).toBeUndefined()
	})

	it('a new model object for the same service remembers what was learnt', async () => {
		const f = await fake('takes-no-criteria')
		await new HttpDecisionModel({ url: f.url }).yesno('s', 'i', {
			criteria: CRITERIA,
		})
		await new HttpDecisionModel({ url: f.url }).yesno('s', 'i', {
			criteria: CRITERIA,
		})
		expect(f.requests).toHaveLength(4)
	})

	it('choice and score are sent as before, also after a yes/no learnt a form', async () => {
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

	it('a model that refuses the folded form too fails with the shape error, not retried again', async () => {
		const f = await fake('refuses-all')
		const model = new HttpDecisionModel({ url: f.url })
		const error = await model.yesno('s', 'i', { criteria: CRITERIA }).catch((e) => e)
		expect(error).toBeInstanceOf(DecisionError)
		expect((error as DecisionError).status).toBe(400)
		expect(refusesQuestionField(error, ['instructions', 'criteria'])).toBe(true)
		// The refusal names instructions, not criteria: nothing to fold, so no second request.
		expect(f.requests).toHaveLength(1)
	})

	it('a 400 for another reason is not retried', async () => {
		const f = await fake('bad-state')
		const error = await new HttpDecisionModel({ url: f.url })
			.yesno('s', 'i', { criteria: CRITERIA })
			.catch((e) => e)
		expect((error as DecisionError).message).toBe('state must not be empty')
		expect(f.requests).toHaveLength(1)
	})

	it('a 401 and a 404 are not retried', async () => {
		for (const status of [401, 404]) {
			const f = await fake('takes-text', status)
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
		expect(f.requests[0]?.questions.q).toEqual({
			type: 'noul',
			instructions: 'i',
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
