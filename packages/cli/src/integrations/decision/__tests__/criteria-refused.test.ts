import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createDecisionModel, forgetCriteriaForms } from '@namzu/decision'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { notifyWorthyQuestion } from '../notify.js'
import { createDecisionPoints } from '../points.js'
import { connectedNotice, testDecisionConnection } from '../setup.js'

/** The body from the report: a validator refusing a string where it wants an object. */
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
const REFUSE_INSTRUCTIONS = JSON.stringify([
	{
		code: 'invalid_type',
		path: ['questions', 'q', 'instructions'],
		message: 'Invalid input',
	},
])

interface Fake {
	url: string
	requests: Record<string, any>[]
}

const servers: Server[] = []

/** `refuse` decides which questions the fake turns away with a 400 and what it says. */
async function fake(refuse: (q: Record<string, any>) => string | undefined): Promise<Fake> {
	const requests: Record<string, any>[] = []
	const server = createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on('data', (c: Buffer) => chunks.push(c))
		req.on('end', () => {
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
			requests.push(body)
			const message = refuse(body.questions.q)
			res.writeHead(message === undefined ? 200 : 400, {
				'Content-Type': 'application/json',
			})
			res.end(
				JSON.stringify(
					message === undefined
						? { answers: { q: { noul: 0.9, type: 'noul' } } }
						: { error: { code: 400, message } },
				),
			)
		})
	})
	servers.push(server)
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/decisions`,
		requests,
	}
}

beforeEach(() => forgetCriteriaForms())
afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

/** Refuses any `criteria` on a yes/no question, as a service that wants none. */
const noText = (q: Record<string, any>) => (q.criteria !== undefined ? SYMPTOM : undefined)
const test = (url: string) =>
	testDecisionConnection({ provider: 'http', url }, {}, { readStoredKey: () => null })

/** No yes/no question in any test carries a string in `criteria`. */
const noStringCriteria = (f: Fake) =>
	expect(f.requests.some((r) => typeof r.questions.q.criteria === 'string')).toBe(false)

describe('a model that refuses the published criteria object', () => {
	it('is connected on the plain line, and later calls pay no second request', async () => {
		const f = await fake(noText)
		const result = await test(f.url)
		expect(result.ok).toBe(true)
		expect(connectedNotice(result)).toMatch(/^Connected · \d+ ms$/)
		const asked = f.requests.length
		await test(f.url)
		expect(f.requests.length).toBe(asked + 1)
		noStringCriteria(f)
	})

	it('a model that follows the published shape is asked once, with the object', async () => {
		const f = await fake((q) => (typeof q.criteria === 'string' ? SYMPTOM : undefined))
		const result = await test(f.url)
		expect(connectedNotice(result)).toMatch(/^Connected · \d+ ms$/)
		expect(f.requests).toHaveLength(1)
		expect(f.requests[0]?.questions.q.criteria).toEqual({
			true: expect.any(String),
		})
		noStringCriteria(f)
	})

	it('a model that refuses the question itself reads as one plain line', async () => {
		const f = await fake(() => REFUSE_INSTRUCTIONS)
		const result = await test(f.url)
		expect(result).toMatchObject({ ok: false, unsupportedModel: true })
		const line = connectedNotice(result)
		expect(line).toBe(
			"Saved, but not connected: the model does not work with Namzu's questions (questions.q.instructions: Invalid input)",
		)
		expect(line).not.toMatch(/[[{]/)
		expect(line.includes('\n')).toBe(false)
	})

	it('a model that refuses the object and the folded form reads as one readable line', async () => {
		const f = await fake((q) => (q.criteria !== undefined ? SYMPTOM : REFUSE_INSTRUCTIONS))
		const result = await test(f.url)
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.unsupportedModel).toBe(true)
		expect(result.reason).toBe(
			"the model does not work with Namzu's questions (questions.q.instructions: Invalid input)",
		)
	})

	it('another 400 reads as before', async () => {
		const f = await fake(() => 'state must not be empty')
		const result = await test(f.url)
		expect(result).toEqual({
			ok: false,
			reason: 'the service answered 400: state must not be empty',
		})
		expect(f.requests).toHaveLength(1)
	})

	it('a real decision point gets its answer from such a model', async () => {
		const f = await fake(noText)
		const model = createDecisionModel({ provider: 'http', url: f.url })
		const points = createDecisionPoints({
			model,
			modes: { notify: 'on' },
			log: () => {},
		})
		const q = notifyWorthyQuestion({
			reply: 'Ready?',
			turnMs: 1000,
			rule: true,
		})
		expect(q.criteria).toBeTruthy()
		expect(await points.ask(q)).toBe(0.9)
		expect(await points.ask(q)).toBe(0.9)
		const last = f.requests.at(-1)?.questions.q
		expect(last.criteria).toBeUndefined()
		expect(last.instructions).toContain(q.criteria)
		// First call: object, folded; second call: folded.
		expect(f.requests).toHaveLength(3)
		noStringCriteria(f)
	})
})
