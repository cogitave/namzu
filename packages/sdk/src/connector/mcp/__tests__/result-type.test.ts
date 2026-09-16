import { describe, expect, it, vi } from 'vitest'

import type {
	MCPJsonRpcMessage,
	MCPJsonSchema,
	MCPToolDefinition,
	MCPTransport,
	MCPTransportUnion,
} from '../../../types/connector/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { mcpToolToToolDefinition } from '../adapter.js'
import { MCPClient } from '../client.js'
import { decodeResult } from '../envelope.js'
import { MCPInputRequiredError, MCPInvalidResultTypeError, MCPProtocolError } from '../errors.js'

/**
 * `resultType` is MRTR's own envelope around a JSON-RPC result: absent or
 * `"complete"` is an ordinary answer, `"input_required"` is a server asking
 * for something this client cannot supply, and anything else is invalid —
 * the spec's own words are "MUST be considered invalid", not merely
 * unrecognized. namzu declares `clientCapabilities: {}`, so per MRTR rule 7
 * a CONFORMING server never sends `input_required` with `inputRequests` —
 * this is the defensive path for one that does anyway, and for `-32021`,
 * the failure a no-capability host is actually likely to see.
 */

describe('decodeResult', () => {
	it('treats an absent resultType as complete', () => {
		const raw = { content: [] }
		expect(decodeResult(raw)).toEqual({ kind: 'complete', result: raw })
	})

	it('treats resultType "complete" as complete', () => {
		const raw = { resultType: 'complete', content: [] }
		expect(decodeResult(raw)).toEqual({ kind: 'complete', result: raw })
	})

	it('refuses an unrecognized resultType rather than passing it through', () => {
		expect(() => decodeResult({ resultType: 'mystery' })).toThrow(MCPInvalidResultTypeError)
	})

	it('reads inputRequests and requestState off an input_required result', () => {
		const decoded = decodeResult({
			resultType: 'input_required',
			inputRequests: [{ method: 'elicitation/create' }],
			requestState: 'opaque-state',
		})
		expect(decoded).toEqual({
			kind: 'input_required',
			inputRequests: [{ method: 'elicitation/create' }],
			requestState: 'opaque-state',
		})
	})

	it('drops an inputRequests entry that has no method, rather than guessing its shape', () => {
		const decoded = decodeResult({
			resultType: 'input_required',
			inputRequests: [{ method: 'sampling/createMessage' }, { notAMethod: true }, 'not an object'],
		})
		expect(decoded).toEqual({
			kind: 'input_required',
			inputRequests: [{ method: 'sampling/createMessage' }],
			requestState: undefined,
		})
	})

	it('a non-object result is complete, not a candidate for a resultType read', () => {
		expect(decodeResult('done')).toEqual({ kind: 'complete', result: 'done' })
		expect(decodeResult(null)).toEqual({ kind: 'complete', result: null })
	})
})

interface Harness {
	client: MCPClient
	sent: MCPJsonRpcMessage[]
}

/** A scripted server that answers `initialize` once and `tools/call` with each of `replies`, in order. */
function harness(replies: readonly unknown[]): Harness {
	const sent: MCPJsonRpcMessage[] = []
	let onMessage: ((m: MCPJsonRpcMessage) => void) | undefined
	let callIndex = 0

	const transport: MCPTransport = {
		connect: async () => {},
		close: async () => {},
		isConnected: () => true,
		send: async (message) => {
			sent.push(message)
			if (message.id === undefined) return
			if (message.method === 'server/discover') {
				// Not a `DiscoverResult` (no `supportedVersions`), so the era
				// probe reads this as a fast, clean "legacy" rather than
				// waiting out the probe timeout for silence.
				queueMicrotask(() => onMessage?.({ jsonrpc: '2.0', id: message.id, result: {} }))
				return
			}
			if (message.method === 'initialize') {
				queueMicrotask(() =>
					onMessage?.({
						jsonrpc: '2.0',
						id: message.id,
						result: { serverInfo: { name: 'fake', version: '1' }, capabilities: {} },
					}),
				)
				return
			}
			if (message.method === 'tools/call') {
				const result = replies[callIndex]
				callIndex++
				queueMicrotask(() => onMessage?.({ jsonrpc: '2.0', id: message.id, result }))
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

function toolCalls(h: Harness): MCPJsonRpcMessage[] {
	return h.sent.filter((m) => m.method === 'tools/call')
}

describe('MCPClient.callTool resolves past the resultType envelope', () => {
	it('a legacy result with no resultType completes normally, exactly once', async () => {
		const h = harness([{ content: [{ type: 'text', text: 'ok' }], isError: false }])
		await h.client.connect()

		const result = await h.client.callTool('t', {})

		expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
		expect(toolCalls(h)).toHaveLength(1)
	})

	it('resultType "complete" completes the same way', async () => {
		const h = harness([{ resultType: 'complete', content: [{ type: 'text', text: 'ok' }] }])
		await h.client.connect()

		const result = await h.client.callTool('t', {})

		expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
		expect(toolCalls(h)).toHaveLength(1)
	})

	it('an unrecognized resultType rejects rather than being silently accepted', async () => {
		const h = harness([{ resultType: 'whatever', content: [] }])
		await h.client.connect()

		await expect(h.client.callTool('t', {})).rejects.toBeInstanceOf(MCPInvalidResultTypeError)
	})

	it('retries a requestState-only input_required exactly once, under a new id, then completes', async () => {
		const h = harness([
			{ resultType: 'input_required', requestState: 'state-123' },
			{ resultType: 'complete', content: [{ type: 'text', text: 'done' }] },
		])
		await h.client.connect()

		const result = await h.client.callTool('t', { a: 1 })

		expect(result.content).toEqual([{ type: 'text', text: 'done' }])
		const calls = toolCalls(h)
		expect(calls).toHaveLength(2)
		expect(calls[0]?.id).not.toBe(calls[1]?.id)
		// requestState travels back byte-for-byte, alongside the ORIGINAL
		// arguments — this is a retry of the same call, not a new one.
		expect(calls[1]?.params?.requestState).toBe('state-123')
		expect(calls[1]?.params?.arguments).toEqual({ a: 1 })
	})

	it('a second input_required after the one retry surfaces the typed error, with no third request', async () => {
		const h = harness([
			{ resultType: 'input_required', requestState: 'state-1' },
			{ resultType: 'input_required', requestState: 'state-2' },
		])
		await h.client.connect()

		await expect(h.client.callTool('t', {})).rejects.toBeInstanceOf(MCPInputRequiredError)
		expect(toolCalls(h)).toHaveLength(2)
	})

	it('inputRequests never trigger an automatic retry', async () => {
		const h = harness([
			{ resultType: 'input_required', inputRequests: [{ method: 'elicitation/create' }] },
		])
		await h.client.connect()

		const caught = await h.client.callTool('t', {}).catch((err: unknown) => err)

		expect(caught).toBeInstanceOf(MCPInputRequiredError)
		expect((caught as MCPInputRequiredError).inputRequests).toEqual([
			{ method: 'elicitation/create' },
		])
		expect(toolCalls(h)).toHaveLength(1)
	})
})

describe('mcpToolToToolDefinition turns an MRTR outcome into a typed, catchable ToolResult', () => {
	const tool: MCPToolDefinition = {
		name: 'book_flight',
		inputSchema: { type: 'object' } as MCPJsonSchema,
	}

	function toolContext(): ToolContext {
		return { abortSignal: new AbortController().signal } as ToolContext
	}

	it('an unsatisfiable inputRequests never throws, and names what was asked for', async () => {
		const client = {
			callTool: vi.fn(async () => {
				throw new MCPInputRequiredError([{ method: 'elicitation/create' }])
			}),
		} as unknown as MCPClient
		const definition = mcpToolToToolDefinition(tool, client, 'srv')

		const result = await definition.execute({}, toolContext())

		expect(result.success).toBe(false)
		expect(result.output).toBe('')
		expect(result.error).toContain('elicitation/create')
		expect(result.data).toEqual({
			code: 'mcp_tool_input_required',
			server: 'srv',
			tool: 'book_flight',
			requested: ['elicitation/create'],
			retrySafety: 'safe',
		})
	})

	it('the typed outcome still passes through the untrusted-content envelope', async () => {
		const client = {
			callTool: vi.fn(async () => {
				throw new MCPInputRequiredError([{ method: 'elicitation/create' }])
			}),
		} as unknown as MCPClient
		const definition = mcpToolToToolDefinition(tool, client, 'srv')

		const result = await definition.execute({}, toolContext())

		expect(result.error).toContain('namzu-untrusted')
	})

	it('-32021 produces a typed outcome naming the required capabilities', async () => {
		const client = {
			callTool: vi.fn(async () => {
				throw new MCPProtocolError(-32021, 'Missing required client capability', {
					requiredCapabilities: ['sampling'],
				})
			}),
		} as unknown as MCPClient
		const definition = mcpToolToToolDefinition(tool, client, 'srv')

		const result = await definition.execute({}, toolContext())

		expect(result.success).toBe(false)
		expect(result.error).toContain('sampling')
		expect(result.data).toEqual({
			code: 'mcp_tool_missing_client_capability',
			server: 'srv',
			tool: 'book_flight',
			requiredCapabilities: ['sampling'],
			retrySafety: 'safe',
		})
	})

	it('a -32021 with malformed data still produces a typed outcome, naming nothing rather than throwing', async () => {
		const client = {
			callTool: vi.fn(async () => {
				throw new MCPProtocolError(-32021, 'Missing required client capability', 'not an object')
			}),
		} as unknown as MCPClient
		const definition = mcpToolToToolDefinition(tool, client, 'srv')

		const result = await definition.execute({}, toolContext())

		expect(result.success).toBe(false)
		expect(result.data).toMatchObject({
			code: 'mcp_tool_missing_client_capability',
			requiredCapabilities: [],
		})
	})

	it('any other error still propagates unchanged', async () => {
		const client = {
			callTool: vi.fn(async () => {
				throw new Error('transport exploded')
			}),
		} as unknown as MCPClient
		const definition = mcpToolToToolDefinition(tool, client, 'srv')

		await expect(definition.execute({}, toolContext())).rejects.toThrow('transport exploded')
	})
})
