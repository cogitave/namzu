import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	MCP_LEGACY_VERSIONS,
	MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from '../../../constants/mcp/index.js'
import type {
	MCPJsonRpcMessage,
	MCPTransport,
	MCPTransportSendOptions,
	MCPTransportUnion,
} from '../../../types/connector/index.js'
import { MCPClient } from '../client.js'

/**
 * A server answers `initialize` with the version IT will speak, which need
 * not be the one the client asked for — that is how the handshake is
 * specified. namzu ignored the answer entirely and carried on regardless,
 * so a server responding with a version this client cannot speak looked
 * exactly like a healthy connection until something downstream broke in a
 * confusing way.
 *
 * `MCP_LEGACY_VERSIONS` broadened that from a single accepted version to
 * four (2025-11-25 down to 2024-11-05), still offered in exactly ONE
 * `initialize` round trip — never a per-version waterfall. The spec's own
 * backward-compatibility algorithm offers one version and honors whatever
 * the server answers with
 * (https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle);
 * a three-step retry loop would be three times the latency for a path no
 * server expects.
 */

function harness(protocolVersion: string | undefined) {
	const sent: Array<{ message: MCPJsonRpcMessage; options?: MCPTransportSendOptions }> = []
	let onMessage: ((m: MCPJsonRpcMessage) => void) | undefined

	const transport: MCPTransport = {
		connect: async () => {},
		close: async () => {},
		isConnected: () => true,
		send: async (message, options) => {
			sent.push({ message, options })
			if (message.id === undefined) return // a notification gets no reply
			if (message.method === 'initialize') {
				queueMicrotask(() =>
					onMessage?.({
						jsonrpc: '2.0',
						id: message.id,
						result: {
							...(protocolVersion !== undefined ? { protocolVersion } : {}),
							serverInfo: { name: 'fake', version: '1' },
							capabilities: {},
						},
					}),
				)
				return
			}
			// Any other request a test issues after connecting (e.g.
			// `tools/list`) gets an empty successful reply so it resolves.
			queueMicrotask(() =>
				onMessage?.({
					jsonrpc: '2.0',
					id: message.id,
					result: { tools: [] },
				}),
			)
		},
		onMessage: (h) => {
			onMessage = h
		},
		onClose: () => {},
		onError: () => {},
	}

	const client = new MCPClient({
		serverName: 'fake',
		transport: { type: 'stdio', command: 'noop' } as MCPTransportUnion,
	})
	;(client as unknown as { transport: MCPTransport }).transport = transport

	return { client, sent }
}

describe('MCP protocol negotiation', () => {
	it('offers the newest legacy version this client speaks', () => {
		// Advertising a newer version whose requirements are unimplemented
		// is worse than advertising an older one honestly: the server
		// tailors its behavior to the claim.
		expect(MCP_SUPPORTED_PROTOCOL_VERSIONS).toContain(MCP_LEGACY_VERSIONS[0])
	})

	it('sends the newest legacy version on initialize', async () => {
		const h = harness(MCP_LEGACY_VERSIONS[0])
		await h.client.connect()

		const init = h.sent.find((r) => r.message.method === 'initialize')?.message
		expect((init?.params as { protocolVersion: string }).protocolVersion).toBe(
			MCP_LEGACY_VERSIONS[0],
		)
	})

	it('accepts a server that answers with the version we asked for', async () => {
		const h = harness(MCP_LEGACY_VERSIONS[0])
		await expect(h.client.connect()).resolves.toBeDefined()
		expect(h.client.isConnected()).toBe(true)
	})

	it('REFUSES a server that negotiates a version this client cannot speak', async () => {
		const h = harness('2099-01-01')
		await expect(h.client.connect()).rejects.toThrow(/negotiated protocol version "2099-01-01"/)
		expect(h.client.isConnected()).toBe(false)
	})

	it('refuses a version outside the supported set, naming the offered version and all four legacy versions', async () => {
		const h = harness('1900-01-01')

		let caught: unknown
		try {
			await h.client.connect()
		} catch (err) {
			caught = err
		}

		expect(caught).toBeInstanceOf(Error)
		const message = (caught as Error).message
		expect(message).toContain('1900-01-01')
		expect(message).toContain(`offered "${MCP_LEGACY_VERSIONS[0]}"`)
		for (const version of MCP_LEGACY_VERSIONS) {
			expect(message).toContain(version)
		}
	})

	it('tolerates a server that omits the version, treating it as the offered one', async () => {
		// Lenient about an ABSENT version, strict about an unsupported one.
		// A missing field is a server being sloppy; a version we cannot
		// speak is a real incompatibility.
		const h = harness(undefined)
		await expect(h.client.connect()).resolves.toBeDefined()
		expect(h.client.getEra()).toEqual({ kind: 'legacy', version: MCP_LEGACY_VERSIONS[0] })
	})
})

describe('every legacy era negotiates in a single initialize round trip', () => {
	it.each(MCP_LEGACY_VERSIONS)(
		'connects at %s, records the matching era, and sends exactly one initialize frame',
		async (version) => {
			const h = harness(version)
			await h.client.connect()

			expect(h.client.isConnected()).toBe(true)
			expect(h.client.getEra()).toEqual({ kind: 'legacy', version })

			// The anti-waterfall guard: nothing anywhere retries `initialize`
			// per version. One offer, one answer, one frame.
			const initializeFrames = h.sent.filter((r) => r.message.method === 'initialize')
			expect(initializeFrames).toHaveLength(1)
		},
	)
})

describe('MCP-Protocol-Version header (introduced in 2025-06-18)', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('sends no MCP-Protocol-Version header when 2025-03-26 is negotiated', async () => {
		const fetchMock = mockThreeCallEra('2025-03-26')
		vi.stubGlobal('fetch', fetchMock)

		const client = new MCPClient({
			serverName: 'fixture',
			transport: { type: 'streamable_http', url: 'https://mcp.example.test/mcp' },
		})
		await client.connect()
		await client.listTools()

		expect(requestAt(fetchMock, 0).headers['MCP-Protocol-Version']).toBeUndefined()
		expect(requestAt(fetchMock, 2).headers['MCP-Protocol-Version']).toBeUndefined()
	})

	it('sends the MCP-Protocol-Version header on tools/list when 2025-06-18 is negotiated, never on initialize itself', async () => {
		const fetchMock = mockThreeCallEra('2025-06-18')
		vi.stubGlobal('fetch', fetchMock)

		const client = new MCPClient({
			serverName: 'fixture',
			transport: { type: 'streamable_http', url: 'https://mcp.example.test/mcp' },
		})
		await client.connect()
		await client.listTools()

		// Never on the initialize request itself: the negotiated version
		// isn't known yet when that request goes out.
		expect(requestAt(fetchMock, 0).headers['MCP-Protocol-Version']).toBeUndefined()
		expect(requestAt(fetchMock, 2).headers['MCP-Protocol-Version']).toBe('2025-06-18')
	})
})

/** initialize -> notifications/initialized -> tools/list, all against one negotiated version. */
function mockThreeCallEra(version: string): ReturnType<typeof vi.fn<typeof fetch>> {
	return vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			jsonResponse({
				jsonrpc: '2.0',
				id: 1,
				result: {
					protocolVersion: version,
					capabilities: {},
					serverInfo: { name: 'fixture' },
				},
			}),
		)
		.mockResolvedValueOnce(new Response(null, { status: 204 }))
		.mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 2, result: { tools: [] } }))
}

function jsonResponse(body: MCPJsonRpcMessage): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	})
}

function requestAt(
	fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
	index: number,
): { headers: Record<string, string> } {
	const call = fetchMock.mock.calls[index]
	if (!call) {
		throw new Error(`No fetch call at index ${index}`)
	}
	const [, init] = call
	if (!init) {
		throw new Error(`Fetch call at index ${index} had no init`)
	}
	return { headers: init.headers as Record<string, string> }
}
