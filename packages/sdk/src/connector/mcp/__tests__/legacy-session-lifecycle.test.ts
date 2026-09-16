import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MCPFetchLike, MCPJsonRpcMessage } from '../../../types/connector/index.js'
import { MCPClient } from '../client.js'
import { createMcpEraCache } from '../era.js'

/**
 * W8: legacy-era session and stream fidelity.
 *
 * Three behaviours the 2025-03-26 through 2025-11-25 Streamable HTTP
 * transports specify and namzu did not implement: a terminated session
 * answers `404` and the client MUST re-initialize; the client SHOULD `DELETE`
 * to close a session it is done with; and none of this ever reaches a modern
 * (2026-07-28) connection, which never had a session to lose in the first
 * place.
 *
 * `config.fetch` injects a scripted responder per test — no global stub, no
 * socket — following the same idiom `per-request-authority.test.ts` and
 * `protocol-negotiation.test.ts` already use.
 */

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('MCP legacy session recovery on a 404', () => {
	it('re-initializes exactly once and then succeeds', async () => {
		const server = scriptedLegacySessionServer({ toolsListFailures: 1 })
		const client = new MCPClient({
			serverName: 'fixture',
			transport: {
				type: 'streamable_http',
				url: 'https://mcp.example.test/mcp',
				fetch: server.fetch,
			},
			eraCache: createMcpEraCache(),
		})

		await client.connect()
		expect(client.getEra()).toEqual({ kind: 'legacy', version: '2025-11-25' })

		await expect(client.listTools()).resolves.toEqual([])

		// initialize, notifications/initialized, tools/list (404), initialize,
		// notifications/initialized, tools/list (success) — one re-initialize,
		// never a loop.
		expect(server.calls.filter((c) => c.method === 'initialize')).toHaveLength(2)
		expect(server.calls.filter((c) => c.method === 'tools/list')).toHaveLength(2)
	})

	it('surfaces the failure rather than looping when a second request also 404s', async () => {
		const server = scriptedLegacySessionServer({ toolsListFailures: Number.POSITIVE_INFINITY })
		const client = new MCPClient({
			serverName: 'fixture',
			transport: {
				type: 'streamable_http',
				url: 'https://mcp.example.test/mcp',
				fetch: server.fetch,
			},
			eraCache: createMcpEraCache(),
		})

		await client.connect()
		await expect(client.listTools()).rejects.toThrow(/HTTP 404/)

		// Exactly one re-initialize attempt: two `tools/list` attempts, two
		// `initialize` calls (the original handshake plus the one recovery),
		// never a third of either.
		expect(server.calls.filter((c) => c.method === 'initialize')).toHaveLength(2)
		expect(server.calls.filter((c) => c.method === 'tools/list')).toHaveLength(2)
	})

	it('drops the stale session id before re-initializing', async () => {
		const server = scriptedLegacySessionServer({ toolsListFailures: 1 })
		const client = new MCPClient({
			serverName: 'fixture',
			transport: {
				type: 'streamable_http',
				url: 'https://mcp.example.test/mcp',
				fetch: server.fetch,
			},
			eraCache: createMcpEraCache(),
		})

		await client.connect()
		await client.listTools()

		const initializeCalls = server.calls.filter((c) => c.method === 'initialize')
		expect(initializeCalls[0]?.hasSessionHeader).toBe(false)
		// The re-initialize is a FRESH handshake: no stale session id
		// attached, exactly as the first one had none.
		expect(initializeCalls[1]?.hasSessionHeader).toBe(false)
	})

	it('never re-initializes a modern connection, which has no session to lose', async () => {
		const server = scriptedModernServer()
		const client = new MCPClient({
			serverName: 'fixture',
			transport: {
				type: 'streamable_http',
				url: 'https://mcp.example.test/mcp',
				fetch: server.fetch,
			},
			eraCache: createMcpEraCache(),
		})

		await client.connect()
		expect(client.getEra()).toEqual({ kind: 'modern', version: '2026-07-28' })
		await expect(client.listTools()).rejects.toThrow(/HTTP 404/)

		// No `initialize` exists on a modern connection at all, so there is
		// nothing to re-run — the 404 must simply surface.
		expect(server.calls.some((c) => c.method === 'initialize')).toBe(false)
	})
})

describe('MCP legacy session teardown on close()', () => {
	it('issues a DELETE carrying the session id', async () => {
		const server = scriptedLegacySessionServer({ toolsListFailures: 0 })
		const client = new MCPClient({
			serverName: 'fixture',
			transport: {
				type: 'streamable_http',
				url: 'https://mcp.example.test/mcp',
				fetch: server.fetch,
			},
			eraCache: createMcpEraCache(),
		})

		await client.connect()
		await client.disconnect()
		// The DELETE is fire-and-forget; give its microtask a turn.
		await new Promise((resolve) => setTimeout(resolve, 0))

		const deleteCalls = server.calls.filter((c) => c.method === 'DELETE')
		expect(deleteCalls).toHaveLength(1)
		expect(deleteCalls[0]?.hasSessionHeader).toBe(true)
	})

	it('issues no DELETE on a modern connection, which never held a session', async () => {
		const server = scriptedModernServer()
		const client = new MCPClient({
			serverName: 'fixture',
			transport: {
				type: 'streamable_http',
				url: 'https://mcp.example.test/mcp',
				fetch: server.fetch,
			},
			eraCache: createMcpEraCache(),
		})

		await client.connect()
		await client.disconnect()
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(server.calls.some((c) => c.method === 'DELETE')).toBe(false)
	})

	it('does not delay close() when the DELETE never answers', async () => {
		let releaseDelete!: () => void
		const held = new Promise<void>((resolve) => {
			releaseDelete = resolve
		})
		const server = scriptedLegacySessionServer({
			toolsListFailures: 0,
			onDelete: () => held,
		})
		const client = new MCPClient({
			serverName: 'fixture',
			transport: {
				type: 'streamable_http',
				url: 'https://mcp.example.test/mcp',
				fetch: server.fetch,
			},
			eraCache: createMcpEraCache(),
		})

		await client.connect()

		const start = Date.now()
		await client.disconnect()
		expect(Date.now() - start).toBeLessThan(500)

		// Clean up the still-pending DELETE so it does not leak into another test.
		releaseDelete()
		await new Promise((resolve) => setTimeout(resolve, 0))
	})
})

/** A JSON-RPC success reply echoing the request's own id. */
function jsonResponse(body: MCPJsonRpcMessage, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json', ...headers },
	})
}

interface RecordedCall {
	readonly method: string | undefined
	readonly hasSessionHeader: boolean
}

/**
 * A legacy (2025-11-25) origin: refuses the modern probe, negotiates
 * `initialize` once, mints a new session id on every `initialize`, and fails
 * a configurable number of `tools/list` attempts with a bare `404` — the
 * legacy Streamable HTTP transport's "your session is gone" answer.
 */
function scriptedLegacySessionServer(options: {
	readonly toolsListFailures: number
	readonly onDelete?: () => Promise<void>
}): { fetch: MCPFetchLike; calls: RecordedCall[] } {
	let sessionEpoch = 0
	let toolsListAttempts = 0
	const calls: RecordedCall[] = []

	const fetchImpl: MCPFetchLike = async (_url, init) => {
		const headers = (init?.headers ?? {}) as Record<string, string>
		const hasSessionHeader = Object.keys(headers).some(
			(name) => name.toLowerCase() === 'mcp-session-id',
		)

		if (init?.method === 'DELETE') {
			calls.push({ method: 'DELETE', hasSessionHeader })
			if (options.onDelete) await options.onDelete()
			return new Response(null, { status: 204 })
		}

		const body = JSON.parse(String(init?.body)) as MCPJsonRpcMessage
		calls.push({ method: body.method, hasSessionHeader })

		if (body.method === 'server/discover') {
			return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } })
		}
		if (body.method === 'initialize') {
			sessionEpoch++
			return jsonResponse(
				{
					jsonrpc: '2.0',
					id: body.id,
					result: {
						protocolVersion: '2025-11-25',
						capabilities: {},
						serverInfo: { name: 'fixture' },
					},
				},
				{ 'mcp-session-id': `sess-${sessionEpoch}` },
			)
		}
		if (body.method === 'notifications/initialized') {
			return new Response(null, { status: 204 })
		}
		if (body.method === 'tools/list') {
			toolsListAttempts++
			if (toolsListAttempts <= options.toolsListFailures) {
				return new Response('', { status: 404 })
			}
			return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [] } })
		}
		throw new Error(`scriptedLegacySessionServer: unscripted method "${body.method}"`)
	}

	return { fetch: fetchImpl, calls }
}

/**
 * A modern (2026-07-28) origin: answers `server/discover` directly, so
 * `connect()` never runs the legacy `initialize` handshake at all and this
 * transport never captures a session id.
 */
function scriptedModernServer(): { fetch: MCPFetchLike; calls: RecordedCall[] } {
	const calls: RecordedCall[] = []

	const fetchImpl: MCPFetchLike = async (_url, init) => {
		const headers = (init?.headers ?? {}) as Record<string, string>
		const hasSessionHeader = Object.keys(headers).some(
			(name) => name.toLowerCase() === 'mcp-session-id',
		)
		const body = JSON.parse(String(init?.body)) as MCPJsonRpcMessage
		calls.push({ method: body.method, hasSessionHeader })

		if (body.method === 'server/discover') {
			return jsonResponse({
				jsonrpc: '2.0',
				id: body.id,
				result: { supportedVersions: ['2026-07-28'], capabilities: {} },
			})
		}
		if (body.method === 'tools/list') {
			return new Response('', { status: 404 })
		}
		throw new Error(`scriptedModernServer: unscripted method "${body.method}"`)
	}

	return { fetch: fetchImpl, calls }
}
