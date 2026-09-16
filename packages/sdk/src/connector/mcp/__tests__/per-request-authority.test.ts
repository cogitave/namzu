import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MCPFetchLike, MCPJsonRpcMessage } from '../../../types/connector/index.js'
import type { LogAttributes } from '../../../utils/log/index.js'
import type { Logger } from '../../../utils/logger.js'
import { MCPClient } from '../client.js'
import { createMcpEraCache } from '../era.js'
import { HttpSseTransport } from '../http-sse.js'
import { StreamableHttpTransport } from '../streamable-http.js'

/**
 * W3: an injectable `fetch`, a per-request bearer token, and per-request
 * headers on `MCPRequestOptions` / `MCPTransportSendOptions`.
 *
 * Real local HTTP servers, not a mocked `fetch`, drive the header-merge and
 * baseline assertions — the same idiom `http-redirect-boundary.test.ts`
 * already uses — so what is asserted is what actually reaches the wire.
 * Only the "the injected fetch is used, the global is never called" tests
 * need a fetch double, and even those forward every call to the REAL global
 * `fetch` (captured before it is stubbed) against a real local server, so a
 * passing test still proves a genuine HTTP exchange happened.
 */

interface TestOrigin {
	readonly url: string
	readonly requests: Array<{
		readonly path: string | undefined
		readonly headers: IncomingMessage['headers']
		readonly body: string
	}>
	readonly server: Server
}

const origins: TestOrigin[] = []

afterEach(async () => {
	await Promise.all(origins.splice(0).map((origin) => closeOrigin(origin)))
	vi.unstubAllGlobals()
})

describe('MCP per-request authority: injected fetch, bearer token, headers', () => {
	describe('the injectable fetch', () => {
		it('serves the Streamable HTTP POST and the global fetch is never called', async () => {
			const realFetch = globalThis.fetch
			const origin = await startOrigin((_request, response) => {
				response.writeHead(204).end()
			})
			const globalFetchMock = vi.fn(() => {
				throw new Error('global fetch must not be called when a fetch is injected')
			})
			vi.stubGlobal('fetch', globalFetchMock)

			const transport = new StreamableHttpTransport({
				type: 'streamable-http',
				url: `${origin.url}/rpc`,
				fetch: realFetch as unknown as MCPFetchLike,
			})
			await transport.connect()
			await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
			await transport.close()

			expect(origin.requests).toHaveLength(1)
			expect(globalFetchMock).not.toHaveBeenCalled()
		})

		it('serves both the HTTP-SSE GET stream and message POST, and the global fetch is never called', async () => {
			const realFetch = globalThis.fetch
			const origin = await startOrigin((request, response) => {
				if (request.url === '/sse') {
					response.writeHead(200, { 'Content-Type': 'text/event-stream' })
					response.write(': ready\n\n')
					return
				}
				response.writeHead(204).end()
			})
			const globalFetchMock = vi.fn(() => {
				throw new Error('global fetch must not be called when a fetch is injected')
			})
			vi.stubGlobal('fetch', globalFetchMock)

			const transport = new HttpSseTransport({
				type: 'http-sse',
				url: origin.url,
				fetch: realFetch as unknown as MCPFetchLike,
			})
			await transport.connect()
			await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
			await transport.close()

			const sseRequest = origin.requests.find((r) => r.path === '/sse')
			const postRequest = origin.requests.find((r) => r.path === '/message')
			expect(sseRequest).toBeDefined()
			expect(postRequest?.body).toContain('tools/list')
			expect(globalFetchMock).not.toHaveBeenCalled()
		})

		it('starts no transport work — not even the injected fetch — for a pre-aborted signal (Streamable HTTP)', async () => {
			const injected = vi.fn<MCPFetchLike>()
			const transport = new StreamableHttpTransport({
				type: 'streamable-http',
				url: 'https://mcp.example.test/rpc',
				fetch: injected,
			})
			await transport.connect()
			const controller = new AbortController()
			controller.abort(new Error('pre-aborted'))

			await expect(
				transport.send(
					{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
					{ signal: controller.signal },
				),
			).rejects.toThrow()

			expect(injected).not.toHaveBeenCalled()
		})

		it('starts no transport work — not even the injected fetch — for a pre-aborted signal (HTTP-SSE)', async () => {
			const injected = vi.fn<MCPFetchLike>().mockImplementation(
				async () =>
					new Response(': ready\n\n', {
						status: 200,
						headers: { 'content-type': 'text/event-stream' },
					}),
			)
			const transport = new HttpSseTransport({
				type: 'http-sse',
				url: 'https://mcp.example.test',
				fetch: injected,
			})
			await transport.connect()
			injected.mockClear()
			const controller = new AbortController()
			controller.abort(new Error('pre-aborted'))

			await expect(
				transport.send(
					{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
					{ signal: controller.signal },
				),
			).rejects.toThrow()

			expect(injected).not.toHaveBeenCalled()
			await transport.close()
		})
	})

	describe('bearer token and per-request headers', () => {
		it('sends a per-request bearer token as Authorization without disturbing a configured X-API-Key', async () => {
			const client = await connectedClient({ 'X-API-Key': 'static-key' })
			await client.client.listTools({ bearerToken: 'call-token' })

			const headers = client.headersFor('tools/list')
			expect(headers.authorization).toBe('Bearer call-token')
			expect(headers['x-api-key']).toBe('static-key')
			await client.client.disconnect()
		})

		it('merges per-request headers over static config headers, per-request wins on collision', async () => {
			const client = await connectedClient({ 'X-Tenant': 'static-tenant', 'X-Other': 'kept' })
			await client.client.listTools({ headers: { 'X-Tenant': 'per-request-tenant' } })

			const headers = client.headersFor('tools/list')
			expect(headers['x-tenant']).toBe('per-request-tenant')
			expect(headers['x-other']).toBe('kept')
			await client.client.disconnect()
		})

		it('overrides a configured Authorization header only when an explicit per-request token is given', async () => {
			const client = await connectedClient({ Authorization: 'Bearer static-token' })

			await client.client.listTools()
			expect(client.headersFor('tools/list', 0).authorization).toBe('Bearer static-token')

			await client.client.listTools({ bearerToken: 'fresh-token' })
			expect(client.headersFor('tools/list', 1).authorization).toBe('Bearer fresh-token')

			await client.client.disconnect()
		})

		it('produces byte-identical headers across two option-free requests — the zero-option baseline is unaffected', async () => {
			const client = await connectedClient({ 'X-API-Key': 'static-key' })
			await client.client.listTools()
			await client.client.listTools()

			const [first, second] = client.allHeadersFor('tools/list')
			expect(second).toEqual(first)
			expect(first?.['content-type']).toBe('application/json')
			expect(first?.accept).toBe('application/json, text/event-stream')
			expect(first?.['x-api-key']).toBe('static-key')
			expect(first?.authorization).toBeUndefined()

			await client.client.disconnect()
		})
	})

	describe('the canonical headers are protected even on an era that sends none of its own', () => {
		// `buildEnvelope` puts no headers at all on a legacy connection older
		// than 2025-06-18 — the revision that introduced `MCP-Protocol-Version`
		// — and `Mcp-Method` / `Mcp-Name` are modern-only headers it never
		// writes on ANY legacy connection. `requestAuthorityHeaders` used to
		// derive its protected set from the era's own header keys, so on
		// these sessions that set was empty and a caller-supplied
		// `MCP-Protocol-Version`, `Mcp-Method` or `Mcp-Name` reached the wire
		// unchanged. These two versions are the ones the era actually
		// negotiates nothing-of-its-own for: 2024-11-05 (no header at all)
		// and 2025-03-26 (still older than the header's introduction).
		it.each(['2024-11-05', '2025-03-26'])(
			'refuses a forged MCP-Protocol-Version / Mcp-Method / Mcp-Name on a %s session',
			async (negotiatedVersion) => {
				const { logger, warnings } = recordingLogger()
				const client = await connectedClient({}, { negotiatedVersion, logger })

				await client.client.listTools({
					headers: {
						'MCP-Protocol-Version': 'forged-version',
						'Mcp-Method': 'forged-method',
						'Mcp-Name': 'forged-name',
						'X-Tenant': 'acme',
					},
				})

				const headers = client.headersFor('tools/list')
				expect(headers['mcp-protocol-version']).toBeUndefined()
				expect(headers['mcp-method']).toBeUndefined()
				expect(headers['mcp-name']).toBeUndefined()
				// Everything the protocol does not own still reaches the wire.
				expect(headers['x-tenant']).toBe('acme')

				const refused = warnings.filter(
					([message]) => message === 'Refused a per-request MCP header the protocol owns',
				)
				expect(refused.map(([, attributes]) => attributes?.['namzu.mcp.header'])).toEqual([
					'MCP-Protocol-Version',
					'Mcp-Method',
					'Mcp-Name',
				])

				await client.client.disconnect()
			},
		)
	})
})

/** A logger that keeps every `warn` body and bag, and swallows the rest. */
function recordingLogger(): { logger: Logger; warnings: [string, LogAttributes?][] } {
	const warnings: [string, LogAttributes?][] = []
	const sink = {
		debug: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		warn: (message: string, attributes?: LogAttributes) => {
			warnings.push([message, attributes])
		},
	}
	const logger = { ...sink, child: () => logger } as unknown as Logger
	return { logger, warnings }
}

/** A connected `MCPClient` over a real local Streamable HTTP origin. */
async function connectedClient(
	staticHeaders: Record<string, string>,
	options: { negotiatedVersion?: string; logger?: Logger } = {},
): Promise<{
	client: MCPClient
	headersFor(method: string, occurrence?: number): IncomingMessage['headers']
	allHeadersFor(method: string): IncomingMessage['headers'][]
}> {
	const origin = await startOrigin((_request, response, body) => {
		const message = JSON.parse(body) as MCPJsonRpcMessage
		if (message.method === 'initialize') {
			respondJson(response, {
				jsonrpc: '2.0',
				id: message.id,
				result: {
					protocolVersion: options.negotiatedVersion ?? '2024-11-05',
					capabilities: { tools: {} },
					serverInfo: { name: 'fixture', version: '1' },
				},
			})
			return
		}
		if (message.method === 'notifications/initialized') {
			response.writeHead(202).end()
			return
		}
		respondJson(response, { jsonrpc: '2.0', id: message.id, result: { tools: [] } })
	})

	const client = new MCPClient({
		serverName: 'fixture',
		transport: { type: 'streamable-http', url: `${origin.url}/rpc`, headers: staticHeaders },
		// Fresh per client: the shared process-default era cache would let a
		// legacy era resolved by one client in this file answer for another
		// client's ORIGIN-DISTINCT connection that happens to reuse a port,
		// and would make this suite's outcome depend on test order.
		eraCache: createMcpEraCache(),
		...(options.logger ? { logger: options.logger } : {}),
	})
	await client.connect()

	const matching = (method: string) =>
		origin.requests
			.map((r) => ({ ...r, parsed: JSON.parse(r.body) as MCPJsonRpcMessage }))
			.filter((r) => r.parsed.method === method)

	return {
		client,
		headersFor: (method, occurrence = 0) => {
			const found = matching(method)[occurrence]
			if (!found) throw new Error(`No "${method}" request at occurrence ${occurrence}`)
			return found.headers
		},
		allHeadersFor: (method) => matching(method).map((r) => r.headers),
	}
}

async function startOrigin(
	handler: (
		request: IncomingMessage,
		response: ServerResponse,
		body: string,
	) => void | Promise<void>,
): Promise<TestOrigin> {
	const requests: TestOrigin['requests'] = []
	const server = createServer(async (request, response) => {
		let body = ''
		for await (const chunk of request) body += String(chunk)
		requests.push({ path: request.url, headers: { ...request.headers }, body })
		await handler(request, response, body)
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject)
			resolve()
		})
	})
	const address = server.address() as AddressInfo
	const origin = { url: `http://127.0.0.1:${address.port}`, requests, server }
	origins.push(origin)
	return origin
}

async function closeOrigin(origin: TestOrigin): Promise<void> {
	origin.server.closeAllConnections()
	await new Promise<void>((resolve) => origin.server.close(() => resolve()))
}

function respondJson(response: ServerResponse, message: MCPJsonRpcMessage): void {
	response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(message))
}
