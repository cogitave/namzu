import { describe, expect, it } from 'vitest'

import {
	CONNECTION_TEST_TIMEOUT_MS,
	type TimeoutHandle,
	connectedNotice,
	listAzureDeployments,
	testDecisionConnection,
} from '../setup.js'

const ok = (p = 0.9) => new Response(JSON.stringify({ answers: { q: { noul: p } } }))
const http = { provider: 'http', url: 'http://127.0.0.1:1/x' } as const
const azure = {
	provider: 'azure',
	endpoint: 'https://r.services.ai.azure.com',
	deployment: 'd',
} as const

/** A timeout the test fires by hand, so no real time is involved. */
function manualTimeout() {
	const controller = new AbortController()
	const asked: number[] = []
	const startTimeout = (ms: number): TimeoutHandle => {
		asked.push(ms)
		return { signal: controller.signal, clear: () => {} }
	}
	return { startTimeout, fire: () => controller.abort(), asked }
}

describe('testDecisionConnection', () => {
	it('is Connected with the time the call took', async () => {
		const ticks = [1000, 1180]
		const result = await testDecisionConnection(
			http,
			{},
			{
				fetch: (async () => ok()) as typeof fetch,
				now: () => ticks.shift() as number,
				readStoredKey: () => null,
			},
		)
		expect(result).toEqual({ ok: true, ms: 180 })
		expect(connectedNotice(result)).toBe('Connected · 180 ms')
	})

	it('sends a criteria sentence that does not state the answer', async () => {
		let sent: { questions?: { q?: { criteria?: { true?: string } } } } = {}
		await testDecisionConnection(
			http,
			{},
			{
				fetch: (async (_u: unknown, init?: RequestInit) => {
					sent = JSON.parse(String(init?.body))
					return ok()
				}) as typeof fetch,
				readStoredKey: () => null,
			},
		)
		const criteria = sent.questions?.q?.criteria?.true ?? ''
		expect(criteria.length).toBeGreaterThan(10)
		expect(criteria).not.toMatch(/this is one/i)
	})

	it('asks for a 3 s deadline', async () => {
		const t = manualTimeout()
		await testDecisionConnection(
			http,
			{},
			{
				fetch: (async () => ok()) as typeof fetch,
				startTimeout: t.startTimeout,
				readStoredKey: () => null,
			},
		)
		expect(t.asked).toEqual([CONNECTION_TEST_TIMEOUT_MS])
		expect(CONNECTION_TEST_TIMEOUT_MS).toBe(3000)
	})

	it('says the key was refused on a 401', async () => {
		const result = await testDecisionConnection(
			azure,
			{},
			{
				fetch: (async () =>
					new Response('{"error":{"message":"bad"}}', { status: 401 })) as typeof fetch,
				readStoredKey: () => 'k',
			},
		)
		expect(result).toEqual({ ok: false, reason: 'the service refused the key (401)' })
	})

	it('says nothing answered on a 404', async () => {
		const result = await testDecisionConnection(
			http,
			{},
			{
				fetch: (async () => new Response('{}', { status: 404 })) as typeof fetch,
				readStoredKey: () => null,
			},
		)
		expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('404') })
	})

	it('says it could not reach the address when the connection fails', async () => {
		const result = await testDecisionConnection(
			http,
			{},
			{
				fetch: (async () => {
					throw new TypeError('fetch failed')
				}) as typeof fetch,
				readStoredKey: () => null,
			},
		)
		expect(result).toEqual({ ok: false, reason: 'could not reach it (fetch failed)' })
	})

	it('gives up at the deadline', async () => {
		const t = manualTimeout()
		const pending = testDecisionConnection(
			http,
			{},
			{
				fetch: ((_url: unknown, init?: RequestInit) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
					})) as typeof fetch,
				startTimeout: t.startTimeout,
				readStoredKey: () => null,
			},
		)
		t.fire()
		expect(await pending).toEqual({ ok: false, reason: 'no answer within 3 s' })
	})

	it('tests the connection even when the kill switch is set for the session', async () => {
		const result = await testDecisionConnection(
			http,
			{ NAMZU_NO_DECISION: '1' },
			{
				fetch: (async () => ok()) as typeof fetch,
				readStoredKey: () => null,
			},
		)
		expect(result.ok).toBe(true)
	})

	it('sends the saved key to the service', async () => {
		let header: string | null = null
		await testDecisionConnection(
			azure,
			{},
			{
				fetch: (async (_u: unknown, init?: RequestInit) => {
					header = new Headers(init?.headers).get('api-key')
					return ok()
				}) as typeof fetch,
				readStoredKey: () => 'the-key',
			},
		)
		expect(header).toBe('the-key')
	})
})

describe('listAzureDeployments', () => {
	it('lists the names the resource gives for the key', async () => {
		let seen = ''
		const names = await listAzureDeployments('https://r.services.ai.azure.com', 'k', {
			fetch: (async (url: string) => {
				seen = url
				return new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }, {}] }))
			}) as unknown as typeof fetch,
		})
		expect(names).toEqual(['a', 'b'])
		expect(seen).toContain('/openai/deployments')
	})

	it('is empty when the resource does not list, refuses, or cannot be reached', async () => {
		const answer = (res: () => Response | never) =>
			listAzureDeployments('https://r.services.ai.azure.com', 'k', {
				fetch: (async () => res()) as unknown as typeof fetch,
			})
		expect(await answer(() => new Response('', { status: 404 }))).toEqual([])
		expect(await answer(() => new Response('{"x":1}'))).toEqual([])
		expect(
			await answer(() => {
				throw new Error('down')
			}),
		).toEqual([])
	})
})
