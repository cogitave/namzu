import { afterEach, describe, expect, it } from 'vitest'

import type {
	MCPJsonRpcMessage,
	MCPTransport,
	MCPTransportUnion,
} from '../../../types/connector/index.js'
import { jsonLinesSink } from '../../../utils/log/index.js'
import { __resetProcessSinkForTests, installProcessSink } from '../../../utils/log/process-sink.js'
import { MCPClient } from '../client.js'

/**
 * `connect()` used to write the remote server's self-reported name straight
 * into the log MESSAGE. `serverInfo.name` is not text the kernel authored —
 * it is whatever the server on the other end of the transport chose to send
 * back — so a hostile server naming itself a fake log line forged a second
 * record in every reader downstream (CWE-117). This pins the fix: the body
 * is a constant string now, the name lives in a namespaced attribute, and
 * the sink's own escaping keeps the forgery text inert as string content
 * instead of a second line.
 */
describe('MCPClient.connect — a hostile server name cannot forge a second log line', () => {
	afterEach(() => {
		__resetProcessSinkForTests()
	})

	it('writes exactly one JSON line, with the forged text confined to an attribute', async () => {
		const chunks: string[] = []
		const stream = {
			write: (chunk: string) => {
				chunks.push(String(chunk))
				return true
			},
		} as unknown as NodeJS.WritableStream
		// Must install BEFORE constructing the client: MCPClient's constructor
		// resolves `getRootLogger()` once, at construction time, and binds
		// `this.log` to whatever destination was in effect then — installing
		// the sink afterwards would leave that binding pointed at the
		// (test-silenced) legacy fallback instead.
		installProcessSink(jsonLinesSink(stream), 'info')

		const hostileName = 'x\n[2026-01-01T00:00:00Z] [ERROR] [audit] forged'

		let onMessage: ((message: MCPJsonRpcMessage) => void) | undefined
		const transport: MCPTransport = {
			connect: async () => {},
			close: async () => {},
			isConnected: () => true,
			send: async (message) => {
				if (message.method !== 'initialize') return
				queueMicrotask(() =>
					onMessage?.({
						jsonrpc: '2.0',
						id: message.id,
						result: { serverInfo: { name: hostileName, version: '1' }, capabilities: {} },
					}),
				)
			},
			onMessage: (handler) => {
				onMessage = handler
			},
			onClose: () => {},
			onError: () => {},
		}

		const client = new MCPClient({
			serverName: 'hostile',
			transport: { type: 'stdio', command: 'noop' } as MCPTransportUnion,
		})
		// Swap in the fake transport — same technique client.test.ts's own
		// harness uses; `createTransport` would otherwise try to spawn a real
		// process.
		;(client as unknown as { transport: MCPTransport }).transport = transport

		await client.connect()

		const lines = chunks.join('').trim().split('\n')
		expect(lines).toHaveLength(1)

		const record = JSON.parse(lines[0] ?? '')
		expect(record.body).toBe('Connected to MCP server')
		expect(record.attributes['namzu.connector.server.name']).toBe(hostileName)
	})
})
