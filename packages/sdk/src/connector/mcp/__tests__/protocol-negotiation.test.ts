import { describe, expect, it } from 'vitest'

import {
	MCP_PROTOCOL_VERSION,
	MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from '../../../constants/mcp/index.js'
import type {
	MCPJsonRpcMessage,
	MCPTransport,
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
 */

function harness(protocolVersion: string | undefined) {
	const sent: MCPJsonRpcMessage[] = []
	let onMessage: ((m: MCPJsonRpcMessage) => void) | undefined

	const transport: MCPTransport = {
		connect: async () => {},
		close: async () => {},
		isConnected: () => true,
		send: async (message) => {
			sent.push(message)
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
			}
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
	it('advertises the version this client actually implements', () => {
		// Advertising a newer version whose requirements are unimplemented
		// is worse than advertising an older one honestly: the server
		// tailors its behavior to the claim.
		expect(MCP_SUPPORTED_PROTOCOL_VERSIONS).toContain(MCP_PROTOCOL_VERSION)
	})

	it('sends the advertised version on initialize', async () => {
		const h = harness(MCP_PROTOCOL_VERSION)
		await h.client.connect()

		const init = h.sent.find((m) => m.method === 'initialize')
		expect((init?.params as { protocolVersion: string }).protocolVersion).toBe(MCP_PROTOCOL_VERSION)
	})

	it('accepts a server that answers with the version we asked for', async () => {
		const h = harness(MCP_PROTOCOL_VERSION)
		await expect(h.client.connect()).resolves.toBeDefined()
		expect(h.client.isConnected()).toBe(true)
	})

	it('REFUSES a server that negotiates a version this client cannot speak', async () => {
		const h = harness('2099-01-01')
		await expect(h.client.connect()).rejects.toThrow(/negotiated protocol version "2099-01-01"/)
		expect(h.client.isConnected()).toBe(false)
	})

	it('names the versions it can speak, so the failure is actionable', async () => {
		const h = harness('1999-01-01')
		await expect(h.client.connect()).rejects.toThrow(
			new RegExp(MCP_SUPPORTED_PROTOCOL_VERSIONS.join(', ')),
		)
	})

	it('tolerates a server that omits the version rather than failing the connection', async () => {
		// Lenient about an ABSENT version, strict about an unsupported one.
		// A missing field is a server being sloppy; a version we cannot
		// speak is a real incompatibility.
		const h = harness(undefined)
		await expect(h.client.connect()).resolves.toBeDefined()
	})
})
