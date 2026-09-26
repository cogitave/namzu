import { describe, expect, it, vi } from 'vitest'

import {
	MCP_META_CLIENT_CAPABILITIES,
	MCP_META_PROTOCOL_VERSION,
	MCP_MODERN_VERSIONS,
	MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from '../../../constants/mcp/index.js'
import type {
	MCPEraCache,
	MCPJsonRpcMessage,
	MCPTransport,
	MCPTransportUnion,
} from '../../../types/connector/index.js'
import type { LogAttributes } from '../../../utils/log/index.js'
import type { Logger } from '../../../utils/logger.js'
import {
	discoverResult,
	jsonRpcResponse,
	jsonRpcStatusResponse,
	scriptedHttpOrigin,
	scriptedStdioServer,
	statusResponse,
} from '../__fixtures__/scripted-era-server.js'
import { MCPClient } from '../client.js'
import { createMcpEraCache } from '../era.js'

/**
 * Which era a connection resolves to, and what a connection in that era
 * does and does not put on the wire.
 *
 * Every case here uses a FRESH era cache. A suite that shared the process
 * default would leak a resolved era from one case into the next and become
 * order-dependent, which is the one failure a conformance suite cannot
 * afford — a case that passes only because the case above it ran first
 * proves nothing about the client.
 */

const MODERN = MCP_MODERN_VERSIONS[0] as string
const ORIGIN = 'https://mcp.example.test'
const URL = `${ORIGIN}/rpc`

function httpClient(
	fetch: ReturnType<typeof scriptedHttpOrigin>['fetch'],
	options: { cache?: MCPEraCache; serverName?: string; logger?: Logger } = {},
): MCPClient {
	return new MCPClient({
		serverName: options.serverName ?? 'fixture',
		transport: { type: 'streamable-http', url: URL, fetch },
		eraCache: options.cache ?? createMcpEraCache(),
		...(options.logger ? { logger: options.logger } : {}),
	})
}

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

/** A client whose declared transport is stdio, driven by a scripted server. */
function stdioClient(
	server: ReturnType<typeof scriptedStdioServer>,
	options: { cache?: MCPEraCache; eraProbeTimeoutMs?: number } = {},
): MCPClient {
	const client = new MCPClient({
		serverName: 'fixture',
		transport: { type: 'stdio', command: 'scripted-server' } as MCPTransportUnion,
		eraCache: options.cache ?? createMcpEraCache(),
		...(options.eraProbeTimeoutMs !== undefined
			? { eraProbeTimeoutMs: options.eraProbeTimeoutMs }
			: {}),
	})
	;(client as unknown as { transport: MCPTransport }).transport = server.transport
	return client
}

/** A modern origin: `server/discover` answers, everything else is scripted. */
function modernOrigin(
	rest: (message: MCPJsonRpcMessage) => Response | Promise<Response>,
	versions: readonly string[] = [MODERN],
): ReturnType<typeof scriptedHttpOrigin> {
	return scriptedHttpOrigin((call) => {
		const message = call.body
		if (message?.method === 'server/discover') {
			return jsonRpcResponse({
				jsonrpc: '2.0',
				id: message.id,
				result: discoverResult({
					supportedVersions: versions,
					capabilities: { tools: { listChanged: true } },
					serverInfo: { name: 'modern-fixture', version: '9' },
				}),
			})
		}
		return rest(message as MCPJsonRpcMessage)
	})
}

/** A legacy origin: it has never heard of `server/discover`. */
function legacyOrigin(
	negotiated = '2025-11-25',
	probeAnswer: () => Response = () => statusResponse(404, 'Not Found'),
): ReturnType<typeof scriptedHttpOrigin> {
	return scriptedHttpOrigin((call) => {
		const message = call.body
		if (message?.method === 'server/discover') return probeAnswer()
		if (message?.method === 'initialize') {
			return jsonRpcResponse({
				jsonrpc: '2.0',
				id: message.id,
				result: {
					protocolVersion: negotiated,
					capabilities: {},
					serverInfo: { name: 'legacy-fixture' },
				},
			})
		}
		if (message?.method === 'notifications/initialized') return new Response(null, { status: 202 })
		return jsonRpcResponse({ jsonrpc: '2.0', id: message?.id, result: { tools: [] } })
	})
}

describe('a modern HTTP origin is reached without a handshake', () => {
	it('connects after the probe without initialize', async () => {
		const origin = modernOrigin((message) =>
			jsonRpcResponse({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }),
		)
		const client = httpClient(origin.fetch)

		const result = await client.connect()

		expect(client.getEra()).toEqual({ kind: 'modern', version: MODERN })
		// A listen stream may start immediately after discovery; it is not
		// another handshake and does not gate connect().
		expect(origin.methods().filter((method) => method !== 'subscriptions/listen')).toEqual([
			'server/discover',
		])
		expect(result.protocolVersion).toBe(MODERN)
		expect(result.serverInfo).toEqual({ name: 'modern-fixture', version: '9' })
		expect(result.capabilities).toEqual({ tools: { listChanged: true } })
	})

	it('carries the required _meta and the mirrored headers on every request', async () => {
		const origin = modernOrigin((message) =>
			jsonRpcResponse({
				jsonrpc: '2.0',
				id: message.id,
				result: { content: [{ type: 'text', text: 'ok' }] },
			}),
		)
		const client = httpClient(origin.fetch)
		await client.connect()
		await client.callTool('create_issue', { title: 'Bug' })

		const call = origin.calls.at(-1)
		const meta = call?.body?.params?._meta as Record<string, unknown>
		expect(meta[MCP_META_PROTOCOL_VERSION]).toBe(MODERN)
		expect(meta[MCP_META_CLIENT_CAPABILITIES]).toEqual({})
		expect(call?.headers['MCP-Protocol-Version']).toBe(MODERN)
		expect(call?.headers['Mcp-Method']).toBe('tools/call')
		expect(call?.headers['Mcp-Name']).toBe('create_issue')
	})

	it('refuses a per-request header that would contradict the body it mirrors', async () => {
		// `buildEnvelope` makes a mismatched header/body pair unconstructible
		// inside one request. A caller header merged OVER the result would
		// reconstruct it one layer up, and a conforming server answers that
		// with a 400 and `-32020` that says nothing about which header caused
		// it. So the three the protocol owns win, and the refusal is logged.
		const origin = modernOrigin((message) =>
			jsonRpcResponse({ jsonrpc: '2.0', id: message.id, result: { content: [] } }),
		)
		const { logger, warnings } = recordingLogger()
		const client = httpClient(origin.fetch, { logger })
		await client.connect()

		await client.callTool(
			'create_issue',
			{ title: 'Bug' },
			{
				headers: {
					'MCP-Protocol-Version': '1999-01-01',
					// Lowercase on purpose: HTTP field names are
					// case-insensitive, so a second spelling is not a second
					// header — it is the same field reaching the wire holding
					// both values, comma-joined.
					'mcp-method': 'tools/list',
					'Mcp-Name': 'something_else',
					'X-Tenant': 'acme',
				},
			},
		)

		const call = origin.calls.at(-1)
		const meta = call?.body?.params?._meta as Record<string, unknown>
		expect(call?.headers['MCP-Protocol-Version']).toBe(MODERN)
		expect(call?.headers['MCP-Protocol-Version']).toBe(meta[MCP_META_PROTOCOL_VERSION])
		expect(call?.headers['Mcp-Method']).toBe('tools/call')
		expect(call?.headers['Mcp-Name']).toBe('create_issue')
		expect(call?.headers['mcp-method']).toBeUndefined()
		// Everything the protocol does NOT own is carried exactly as given.
		expect(call?.headers['X-Tenant']).toBe('acme')

		const refused = warnings.filter(
			([message]) => message === 'Refused a per-request MCP header the protocol owns',
		)
		expect(refused.map(([, attributes]) => attributes?.['namzu.mcp.header'])).toEqual([
			'MCP-Protocol-Version',
			'mcp-method',
			'Mcp-Name',
		])
	})

	it('sends no session id, no GET and no DELETE even when the origin offers a session', async () => {
		// The modern era removed sessions. An origin that hands one out
		// anyway must not get it back: replaying a session id it may have
		// rotated is how one stale header poisons every later request.
		const origin = scriptedHttpOrigin((call) => {
			const message = call.body
			if (message?.method === 'server/discover') {
				return new Response(
					JSON.stringify({
						jsonrpc: '2.0',
						id: message.id,
						result: discoverResult({ supportedVersions: [MODERN] }),
					}),
					{
						status: 200,
						headers: { 'content-type': 'application/json', 'mcp-session-id': 'sid_offered' },
					},
				)
			}
			return jsonRpcResponse({ jsonrpc: '2.0', id: message?.id, result: { tools: [] } })
		})
		const client = httpClient(origin.fetch)

		await client.connect()
		await client.listTools()
		await client.disconnect()

		expect(origin.calls.every((call) => call.httpMethod === 'POST')).toBe(true)
		expect(origin.calls.every((call) => call.headers['Mcp-Session-Id'] === undefined)).toBe(true)
	})
})

describe('the negotiated protocol version is the client\u2019s to send, in either era', () => {
	it('refuses a per-request MCP-Protocol-Version on a legacy connection too', async () => {
		// The header is younger than the era it is sent in, but it is no less
		// the protocol's: 2025-06-18 on says the client sends the version it
		// NEGOTIATED. A caller value there is a claim the handshake did not
		// make, so it is refused in this era exactly as in the modern one.
		const origin = legacyOrigin()
		const { logger, warnings } = recordingLogger()
		const client = httpClient(origin.fetch, { logger })
		await client.connect()

		await client.listTools({ headers: { 'MCP-Protocol-Version': '1999-01-01' } })

		const call = origin.calls.at(-1)
		expect(call?.headers['MCP-Protocol-Version']).toBe('2025-11-25')
		expect(
			warnings.some(
				([message]) => message === 'Refused a per-request MCP header the protocol owns',
			),
		).toBe(true)
	})
})

describe('an unsupported protocol version is retried once, or refused', () => {
	it('falls back to the legacy handshake when the server names only legacy versions', async () => {
		const origin = scriptedHttpOrigin((call) => {
			const message = call.body
			if (message?.method === 'server/discover') {
				return jsonRpcStatusResponse(400, message.id, {
					code: -32022,
					message: 'Unsupported protocol version',
					data: { supported: ['2025-11-25'], requested: MODERN },
				})
			}
			if (message?.method === 'initialize') {
				return jsonRpcResponse({
					jsonrpc: '2.0',
					id: message.id,
					result: {
						protocolVersion: '2025-11-25',
						capabilities: {},
						serverInfo: { name: 'legacy-fixture' },
					},
				})
			}
			return new Response(null, { status: 202 })
		})
		const client = httpClient(origin.fetch)

		await client.connect()

		expect(client.getEra()).toEqual({ kind: 'legacy', version: '2025-11-25' })
		// Exactly one probe and exactly one handshake: no loop anywhere.
		expect(origin.methods().filter((m) => m === 'server/discover')).toHaveLength(1)
		expect(origin.methods().filter((m) => m === 'initialize')).toHaveLength(1)
	})

	it('refuses a server whose supported versions are disjoint from ours, naming both lists', async () => {
		const origin = scriptedHttpOrigin((call) =>
			jsonRpcStatusResponse(400, call.body?.id, {
				code: -32022,
				message: 'Unsupported protocol version',
				data: { supported: ['1999-01-01'], requested: MODERN },
			}),
		)
		const client = httpClient(origin.fetch, { serverName: 'stubborn' })

		const error = await client.connect().catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(Error)
		const message = (error as Error).message
		expect(message).toContain('stubborn')
		expect(message).toContain('1999-01-01')
		for (const version of MCP_SUPPORTED_PROTOCOL_VERSIONS) expect(message).toContain(version)
		// Refused, not retried with a version this client does not implement.
		expect(origin.methods()).toEqual(['server/discover'])
	})
})

describe('a server cannot answer the legacy handshake with a modern revision', () => {
	it('refuses, rather than recording a legacy era at a version that is not a legacy one', async () => {
		// A real modern server does not implement `initialize` at all, so this
		// success shape is a contradiction. Accepting it would write the
		// modern version number onto requests carrying none of what that
		// version requires.
		const origin = scriptedHttpOrigin((call) => {
			const message = call.body
			if (message?.method === 'server/discover') return statusResponse(404, 'Not Found')
			return jsonRpcResponse({
				jsonrpc: '2.0',
				id: message?.id,
				result: {
					protocolVersion: MODERN,
					capabilities: {},
					serverInfo: { name: 'confused' },
				},
			})
		})
		const client = httpClient(origin.fetch, { serverName: 'confused' })

		const error = await client.connect().catch((caught: unknown) => caught)

		expect((error as Error).message).toContain('is not a legacy revision')
		expect((error as Error).message).toContain(MODERN)
		expect(client.isConnected()).toBe(false)
	})
})

describe('an HTTP failure is read for evidence, not treated as a fallback signal', () => {
	it('falls back when a 400 carries no body at all', async () => {
		const origin = legacyOrigin('2025-11-25', () => statusResponse(400, ''))
		const client = httpClient(origin.fetch)

		await client.connect()

		expect(client.getEra()?.kind).toBe('legacy')
		expect(origin.methods()).toContain('initialize')
	})

	it('falls back when a 404 carries an HTML error page', async () => {
		const origin = legacyOrigin('2025-11-25', () =>
			statusResponse(404, '<html><body>Not Found</body></html>', 'text/html'),
		)
		const client = httpClient(origin.fetch)

		await client.connect()

		expect(client.getEra()?.kind).toBe('legacy')
		expect(origin.methods()).toContain('initialize')
	})

	it('does NOT fall back when a 400 carries a -32021', async () => {
		const origin = legacyOrigin('2025-11-25', () =>
			jsonRpcStatusResponse(400, 1, {
				code: -32021,
				message: 'Missing required client capability',
				data: { requiredCapabilities: ['sampling'] },
			}),
		)
		const client = httpClient(origin.fetch)

		await client.connect()

		expect(client.getEra()).toEqual({ kind: 'modern', version: MODERN })
		expect(origin.methods()).toEqual(['server/discover'])
	})

	it('does NOT fall back when a 404 carries a -32601 — the case a status alone gets wrong', async () => {
		// A modern server answers an unknown method with 404 plus a JSON-RPC
		// -32601 specifically so this is distinguishable from the 404 of an
		// origin that has never heard of the protocol.
		const origin = legacyOrigin('2025-11-25', () =>
			jsonRpcStatusResponse(404, 1, { code: -32601, message: 'Method not found' }),
		)
		const client = httpClient(origin.fetch)

		await client.connect()

		expect(client.getEra()).toEqual({ kind: 'modern', version: MODERN })
		expect(origin.methods()).toEqual(['server/discover'])
	})

	it('DOES fall back when a 400 carries a -32601, which any era can send', async () => {
		const origin = legacyOrigin('2025-11-25', () =>
			jsonRpcStatusResponse(400, 1, { code: -32601, message: 'Method not found' }),
		)
		const client = httpClient(origin.fetch)

		await client.connect()

		expect(client.getEra()?.kind).toBe('legacy')
	})
})

describe('the stdio probe answers to silence as well as to errors', () => {
	it('resolves modern when server/discover returns a DiscoverResult', async () => {
		const server = scriptedStdioServer((message) =>
			message.method === 'server/discover'
				? {
						jsonrpc: '2.0',
						id: message.id,
						result: discoverResult({
							supportedVersions: [MODERN],
							serverInfo: { name: 'modern-stdio' },
						}),
					}
				: { jsonrpc: '2.0', id: message.id, result: { tools: [] } },
		)
		const client = stdioClient(server)

		const result = await client.connect()

		expect(client.getEra()).toEqual({ kind: 'modern', version: MODERN })
		expect(server.methods()).toEqual(['server/discover'])
		expect(result.serverInfo).toEqual({ name: 'modern-stdio' })
	})

	it.each([-32601, -32602, -32000])(
		'falls back to the legacy handshake on a %i, whatever the code happens to be',
		async (code) => {
			// The fallback predicate is "did this answer in the modern
			// vocabulary?", never "was this -32601?". A legacy server refuses
			// an unknown method with whatever its implementation uses.
			const server = scriptedStdioServer((message) => {
				if (message.method === 'server/discover') {
					return { jsonrpc: '2.0', id: message.id, error: { code, message: 'no' } }
				}
				if (message.method === 'initialize') {
					return {
						jsonrpc: '2.0',
						id: message.id,
						result: {
							protocolVersion: '2025-11-25',
							capabilities: {},
							serverInfo: { name: 'legacy-stdio' },
						},
					}
				}
				return undefined
			})
			const client = stdioClient(server)

			await client.connect()

			expect(client.getEra()).toEqual({ kind: 'legacy', version: '2025-11-25' })
			expect(server.methods().filter((m) => m === 'server/discover')).toHaveLength(1)
			expect(server.methods().filter((m) => m === 'initialize')).toHaveLength(1)
		},
	)

	it('resolves modern on a -32022, and sends no initialize', async () => {
		const server = scriptedStdioServer((message) =>
			message.method === 'server/discover'
				? {
						jsonrpc: '2.0',
						id: message.id,
						error: {
							code: -32022,
							message: 'Unsupported protocol version',
							data: { supported: [MODERN], requested: MODERN },
						},
					}
				: { jsonrpc: '2.0', id: message.id, result: {} },
		)
		const client = stdioClient(server)

		await client.connect()

		expect(client.getEra()).toEqual({ kind: 'modern', version: MODERN })
		expect(server.methods()).toEqual(['server/discover'])
	})

	it('falls back after the probe timeout when the server never answers', async () => {
		const server = scriptedStdioServer((message) =>
			message.method === 'initialize'
				? {
						jsonrpc: '2.0',
						id: message.id,
						result: {
							protocolVersion: '2024-11-05',
							capabilities: {},
							serverInfo: { name: 'silent-then-legacy' },
						},
					}
				: undefined,
		)
		const client = stdioClient(server, { eraProbeTimeoutMs: 20 })

		await client.connect()

		expect(client.getEra()).toEqual({ kind: 'legacy', version: '2024-11-05' })
		// Silence is an answer about the era, so it must not become a
		// cancellation notification aimed at a server that never started.
		expect(server.methods()).not.toContain('notifications/cancelled')
	})
})

describe('an era is remembered per origin and corrected when it stops holding', () => {
	it('probes a legacy origin once, however many clients reach it', async () => {
		const cache = createMcpEraCache()
		const origin = legacyOrigin()

		await httpClient(origin.fetch, { cache }).connect()
		await httpClient(origin.fetch, { cache }).connect()

		expect(origin.methods().filter((m) => m === 'server/discover')).toHaveLength(1)
		expect(origin.methods().filter((m) => m === 'initialize')).toHaveLength(2)
	})

	it('keeps sending server/discover to a modern origin, because it IS the connection', async () => {
		// The cache saves the WASTED probe against a legacy origin. Against a
		// modern one the probe carries the server's capabilities — so a cached era does not
		// make it skippable, it makes the fallback skippable.
		const cache = createMcpEraCache()
		const origin = modernOrigin((message) =>
			jsonRpcResponse({ jsonrpc: '2.0', id: message.id, result: {} }),
		)

		await httpClient(origin.fetch, { cache }).connect()
		await httpClient(origin.fetch, { cache }).connect()

		expect(origin.methods().filter((method) => method !== 'subscriptions/listen')).toEqual([
			'server/discover',
			'server/discover',
		])
	})

	it('corrects a remembered modern origin that starts answering as legacy, and does not repeat the cost', async () => {
		const cache = createMcpEraCache()
		let modern = true
		const origin = scriptedHttpOrigin((call) => {
			const message = call.body
			if (message?.method === 'server/discover') {
				return modern
					? jsonRpcResponse({
							jsonrpc: '2.0',
							id: message.id,
							result: discoverResult({ supportedVersions: [MODERN] }),
						})
					: statusResponse(404, 'Not Found')
			}
			if (message?.method === 'initialize') {
				return jsonRpcResponse({
					jsonrpc: '2.0',
					id: message.id,
					result: {
						protocolVersion: '2025-11-25',
						capabilities: {},
						serverInfo: { name: 'downgraded' },
					},
				})
			}
			return new Response(null, { status: 202 })
		})

		await httpClient(origin.fetch, { cache }).connect()
		expect(cache.get(`streamable-http ${ORIGIN}`)).toEqual({ kind: 'modern', version: MODERN })

		modern = false
		const corrected = httpClient(origin.fetch, { cache })
		await corrected.connect()

		expect(corrected.getEra()?.kind).toBe('legacy')
		expect(cache.get(`streamable-http ${ORIGIN}`)).toEqual({
			kind: 'legacy',
			version: '2025-11-25',
		})

		// The wrong assumption cost one probe, once. The next connection
		// inherits the correction instead of repeating it.
		const after = origin.methods().length
		await httpClient(origin.fetch, { cache }).connect()
		expect(origin.methods().slice(after)).toEqual(['initialize', 'notifications/initialized'])
	})

	it('forgets a remembered era when the handshake it implies cannot complete', async () => {
		const cache = createMcpEraCache()
		let refuse = false
		const origin = scriptedHttpOrigin((call) => {
			const message = call.body
			if (message?.method === 'server/discover') return statusResponse(404, 'Not Found')
			if (message?.method === 'initialize') {
				return refuse
					? statusResponse(500, 'boom')
					: jsonRpcResponse({
							jsonrpc: '2.0',
							id: message.id,
							result: {
								protocolVersion: '2025-11-25',
								capabilities: {},
								serverInfo: { name: 'flaky' },
							},
						})
			}
			return new Response(null, { status: 202 })
		})

		await httpClient(origin.fetch, { cache }).connect()
		refuse = true
		await expect(httpClient(origin.fetch, { cache }).connect()).rejects.toThrow()

		expect(cache.get(`streamable-http ${ORIGIN}`)).toBeUndefined()
	})
})

describe('cancellation on a modern connection', () => {
	it('does not POST notifications/cancelled on modern Streamable HTTP', async () => {
		// Closing the SSE response stream IS the cancellation signal there,
		// so the notification would be a second, redundant POST.
		// The tool call is left in flight; only the abort ends it.
		const origin = modernOrigin(() => new Promise<Response>(() => {}))
		const client = httpClient(origin.fetch)
		await client.connect()

		const caller = new AbortController()
		const call = client.callTool('slow', {}, { signal: caller.signal })
		caller.abort(new Error('stop'))
		await expect(call).rejects.toThrow()
		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(origin.methods()).not.toContain('notifications/cancelled')
	})

	it('still sends notifications/cancelled on modern stdio, which has no stream to close', async () => {
		const server = scriptedStdioServer((message) =>
			message.method === 'server/discover'
				? {
						jsonrpc: '2.0',
						id: message.id,
						result: discoverResult({ supportedVersions: [MODERN] }),
					}
				: undefined,
		)
		const client = stdioClient(server)
		await client.connect()

		const caller = new AbortController()
		const call = client.callTool('slow', {}, { signal: caller.signal })
		caller.abort(new Error('stop'))
		await expect(call).rejects.toThrow()
		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(server.methods()).toContain('notifications/cancelled')
	})
})
