import { describe, expect, it, vi } from 'vitest'
import type { MCPJsonRpcMessage, MCPTransport } from '../../../types/connector/mcp.js'
import { MCPClient } from '../client.js'

function scriptedTransport() {
	let connected = false
	let onMessage: ((message: MCPJsonRpcMessage) => void) | undefined
	let onClose: (() => void) | undefined
	const sent: MCPJsonRpcMessage[] = []
	const transport: MCPTransport = {
		async connect() {
			connected = true
		},
		async close() {
			connected = false
			onClose?.()
			onMessage = undefined
			onClose = undefined
		},
		isConnected: () => connected,
		onMessage(handler) {
			onMessage = handler
		},
		onClose(handler) {
			onClose = handler
		},
		onError() {},
		async send(message, options) {
			options?.signal?.throwIfAborted()
			sent.push(message)
			if (message.id === undefined) return
			const result =
				message.method === 'initialize'
					? {
							protocolVersion: '2024-11-05',
							capabilities: { tools: {} },
							serverInfo: { name: 'guest-server' },
						}
					: message.method === 'tools/call'
						? { content: [{ type: 'text', text: 'guest reply' }] }
						: {}
			onMessage?.({ jsonrpc: '2.0', id: message.id, result })
		},
	}
	return { transport, sent }
}

describe('caller-owned MCP transports', () => {
	it('negotiates, dispatches, cancels pre-aborted work and reconnects without host subprocesses', async () => {
		const scripted = scriptedTransport()
		const factory = vi.fn(() => scripted.transport)
		const client = new MCPClient({
			serverName: 'guest',
			transport: { type: 'stdio', command: '/not-a-host-program' },
			transportFactory: factory,
		})
		expect((await client.connect()).serverInfo.name).toBe('guest-server')
		expect((await client.callTool('model', {})).content).toEqual([
			{ type: 'text', text: 'guest reply' },
		])
		const before = scripted.sent.length
		await expect(
			client.callTool('model', {}, { signal: AbortSignal.abort(new Error('pre-aborted')) }),
		).rejects.toThrow('pre-aborted')
		expect(scripted.sent).toHaveLength(before)
		await client.disconnect()
		await client.connect()
		expect(factory).toHaveBeenCalledTimes(1)
		await client.disconnect()
	})
	it('does not fall back to a built-in transport when the supplied factory fails', () => {
		expect(
			() =>
				new MCPClient({
					serverName: 'guest',
					transport: { type: 'stdio', command: '/not-a-host-program' },
					transportFactory: () => {
						throw new Error('Guest lease retired')
					},
				}),
		).toThrow('Guest lease retired')
	})
})
