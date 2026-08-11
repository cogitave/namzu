import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

import type { MCPJsonRpcMessage } from '../../../types/connector/mcp.js'
import { ServerStdioTransport } from '../server-stdio.js'
import { MCPServer } from '../server.js'

/**
 * `MCPServer` was a complete protocol implementation with no caller,
 * because every transport in this directory is the client side. These
 * tests drive the real server through the real transport, so what they
 * establish is that the two halves fit — not that either half parses.
 */

/** Collects whatever the server writes, one parsed message per line. */
function harness() {
	const input = new PassThrough()
	const output = new PassThrough()
	const written: MCPJsonRpcMessage[] = []

	let pending = ''
	output.on('data', (chunk: Buffer) => {
		pending += chunk.toString('utf8')
		let nl = pending.indexOf('\n')
		while (nl !== -1) {
			const line = pending.slice(0, nl).trim()
			pending = pending.slice(nl + 1)
			if (line) written.push(JSON.parse(line) as MCPJsonRpcMessage)
			nl = pending.indexOf('\n')
		}
	})

	return { input, output, written }
}

function serverWith(tools: Array<{ name: string; description: string }>) {
	return new MCPServer(
		{ name: 'namzu', version: '1.0.0' },
		{
			listTools: () =>
				tools.map((t) => ({
					name: t.name,
					description: t.description,
					inputSchema: { type: 'object' as const, properties: {} },
				})),
			callTool: async (name: string) => ({
				content: [{ type: 'text' as const, text: `ran ${name}` }],
			}),
		},
	)
}

/** Give the event loop a turn so stream data is delivered and handled. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('a client driving namzu over stdio', () => {
	it('gets the tool list it asked for', async () => {
		const { input, output, written } = harness()
		const server = serverWith([{ name: 'run_agent', description: 'Run an agent' }])
		await server.start(new ServerStdioTransport({ input, output }))

		input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
		await settle()

		const reply = written.find((m) => (m as { id?: number }).id === 1)
		expect(reply).toBeDefined()
		const result = (reply as { result?: { tools?: Array<{ name: string }> } }).result
		expect(result?.tools?.map((t) => t.name)).toEqual(['run_agent'])
	})

	it('reads two messages that arrived in one chunk', async () => {
		// A read is whatever size the pipe hands over. Treating one read as
		// one message is the framing bug this transport exists to not have,
		// and it only shows up under load — which is where it is worst.
		const { input, output, written } = harness()
		const server = serverWith([{ name: 'a', description: 'a' }])
		await server.start(new ServerStdioTransport({ input, output }))

		input.write(
			`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
		)
		await settle()

		expect(written.map((m) => (m as { id?: number }).id).filter(Boolean)).toEqual([1, 2])
	})

	it('reads one message that arrived split across two chunks', async () => {
		// The other half of the same framing question, and the more common
		// one: a long tool schema does not fit in one read.
		const { input, output, written } = harness()
		const server = serverWith([{ name: 'a', description: 'a' }])
		await server.start(new ServerStdioTransport({ input, output }))

		const message = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })
		input.write(message.slice(0, 12))
		await settle()
		expect(written).toHaveLength(0)

		input.write(`${message.slice(12)}\n`)
		await settle()
		expect((written[0] as { id?: number }).id).toBe(7)
	})

	it('survives a malformed line and still answers the next request', async () => {
		// One bad line is not the end of a session. Tearing down the
		// transport would take every other conversation on the pipe with it,
		// and silence would look to the client exactly like a hung server.
		const { input, output, written } = harness()
		const server = serverWith([{ name: 'a', description: 'a' }])
		const transport = new ServerStdioTransport({ input, output })
		await server.start(transport)

		input.write('this is not json\n')
		await settle()
		input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' })}\n`)
		await settle()

		// Asserted through the server rather than by watching the error slot:
		// `start` registers its own handlers and the slots are last-wins, so a
		// test that installed its own would be measuring a transport the
		// server is no longer wired to.
		expect((written[0] as { id?: number }).id).toBe(9)
		expect(transport.isConnected()).toBe(true)
	})

	it('writes nothing to the stream until it is asked something', async () => {
		// stdout IS the protocol here. A transport that greeted the client,
		// or a logger that wrote a banner, would corrupt the first message.
		const { input, output, written } = harness()
		const server = serverWith([{ name: 'a', description: 'a' }])
		await server.start(new ServerStdioTransport({ input, output }))
		await settle()

		expect(written).toHaveLength(0)
		expect(input.listenerCount('data')).toBe(1)
	})

	it('reports the stream ending as a close rather than an error', async () => {
		// Driven without a server. The handler slots are single-assignment
		// and `start` claims them, so this property belongs to the transport
		// on its own — asserting it through a server would only prove which
		// of the two registered last.
		const { input, output } = harness()
		const transport = new ServerStdioTransport({ input, output })
		let closed = false
		let errored = false
		transport.onClose(() => {
			closed = true
		})
		transport.onError(() => {
			errored = true
		})
		await transport.connect()

		input.end()
		await settle()

		expect(closed).toBe(true)
		expect(errored).toBe(false)
		expect(transport.isConnected()).toBe(false)
	})

	it('reports a malformed line to the error slot without disconnecting', async () => {
		// The transport-level half of the survival test above.
		const { input, output } = harness()
		const transport = new ServerStdioTransport({ input, output })
		const errors: Error[] = []
		const seen: MCPJsonRpcMessage[] = []
		transport.onError((err) => errors.push(err))
		transport.onMessage((msg) => seen.push(msg))
		await transport.connect()

		input.write('not json\n')
		input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' })}\n`)
		await settle()

		expect(errors).toHaveLength(1)
		expect(errors[0]?.message).toContain('could not parse')
		expect(seen).toHaveLength(1)
		expect(transport.isConnected()).toBe(true)
	})
})
