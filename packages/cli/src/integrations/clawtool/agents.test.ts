import { describe, expect, it, vi } from 'vitest'

import { type Agent, listAgents } from './agents.js'

function makeAgentsResponse(agents: readonly Agent[]): Response {
	return new Response(JSON.stringify({ agents, count: agents.length }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	})
}

describe('listAgents', () => {
	it('hits /v1/agents and returns the agents array', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			makeAgentsResponse([
				{ instance: 'claude', family: 'claude', status: 'callable', callable: true },
				{
					instance: 'codex',
					family: 'codex',
					bridge: 'codex-bridge',
					status: 'callable',
					callable: true,
				},
			]),
		)
		const agents = await listAgents({
			endpoint: 'http://localhost:9999',
			token: 'tok',
			fetch: fetchMock,
		})
		expect(agents.length).toBe(2)
		expect(agents[0]?.instance).toBe('claude')
		// Without callableOnly the URL has no query string.
		const url = fetchMock.mock.calls[0]?.[0] as string
		expect(url).toBe('http://localhost:9999/v1/agents')
	})

	it('passes ?status=callable when callableOnly is set', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(makeAgentsResponse([]))
		await listAgents({
			endpoint: 'http://localhost:9999',
			token: 'tok',
			fetch: fetchMock,
			callableOnly: true,
		})
		const url = fetchMock.mock.calls[0]?.[0] as string
		expect(url).toBe('http://localhost:9999/v1/agents?status=callable')
	})

	it('includes the Bearer header when a token is provided', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(makeAgentsResponse([]))
		await listAgents({
			endpoint: 'http://localhost:9999',
			token: 'tok-abc',
			fetch: fetchMock,
		})
		const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>
		expect(headers.Authorization).toBe('Bearer tok-abc')
	})

	it('omits the Bearer header when the token is empty (no-auth daemon)', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(makeAgentsResponse([]))
		await listAgents({
			endpoint: 'http://localhost:9999',
			token: '',
			fetch: fetchMock,
		})
		const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>
		expect(headers.Authorization).toBeUndefined()
	})

	it('throws when the response is non-2xx', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 500 }))
		await expect(
			listAgents({
				endpoint: 'http://localhost:9999',
				token: '',
				fetch: fetchMock,
			}),
		).rejects.toThrow(/HTTP 500/)
	})

	it('throws when the response body shape is unexpected', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ not: 'agents' }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		)
		await expect(
			listAgents({ endpoint: 'http://localhost:9999', token: '', fetch: fetchMock }),
		).rejects.toThrow(/unexpected shape/)
	})
})
