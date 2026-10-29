import { describe, expect, it } from 'vitest'

import type {
	MCPElicitationRequest,
	MCPElicitationResult,
	MCPJsonRpcMessage,
	MCPTransport,
	MCPTransportUnion,
} from '../../types/connector/index.js'
import { MCPClient } from './client.js'
import { createMcpEraCache } from './era.js'

/** A legacy-era client over a scripted transport, with or without an elicitation handler. */
function setup(
	onElicitation?: (
		request: MCPElicitationRequest,
		context: { signal: AbortSignal },
	) => Promise<MCPElicitationResult>,
) {
	const sent: MCPJsonRpcMessage[] = []
	let deliver: ((m: MCPJsonRpcMessage) => void) | undefined
	const transport: MCPTransport = {
		connect: async () => {},
		close: async () => {},
		isConnected: () => true,
		send: async (message) => {
			sent.push(message)
			if (message.method === 'server/discover') {
				queueMicrotask(() => deliver?.({ jsonrpc: '2.0', id: message.id, result: {} }))
			} else if (message.method === 'initialize') {
				queueMicrotask(() =>
					deliver?.({
						jsonrpc: '2.0',
						id: message.id,
						result: { serverInfo: { name: 'fake' }, capabilities: {} },
					}),
				)
			}
		},
		onMessage: (h) => {
			deliver = h
		},
		onClose: () => {},
		onError: () => {},
	}
	const client = new MCPClient({
		serverName: 'fake',
		transport: { type: 'stdio', command: 'noop' } as MCPTransportUnion,
		eraCache: createMcpEraCache(),
		...(onElicitation ? { onElicitation } : {}),
	})
	;(client as unknown as { transport: MCPTransport }).transport = transport
	const reply = (id: number) => sent.find((m) => m.id === id && m.method === undefined)
	const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
	return { client, sent, receive: (m: MCPJsonRpcMessage) => deliver?.(m), reply, settle }
}

const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }

describe('MCPClient elicitation', () => {
	it('declares the form capability only when a handler exists', async () => {
		const withHandler = setup(async () => ({ action: 'decline' }))
		await withHandler.client.connect()
		const init = withHandler.sent.find((m) => m.method === 'initialize')
		expect((init?.params as { capabilities: unknown }).capabilities).toMatchObject({
			elicitation: {},
		})

		const without = setup()
		await without.client.connect()
		const plain = without.sent.find((m) => m.method === 'initialize')
		expect((plain?.params as { capabilities: object }).capabilities).not.toHaveProperty(
			'elicitation',
		)
	})

	it('hands a form request to the handler and sends back what it accepted', async () => {
		let seen: MCPElicitationRequest | undefined
		const h = setup(async (request) => {
			seen = request
			return { action: 'accept', content: { name: 'Ada' } }
		})
		await h.client.connect()
		h.receive({
			jsonrpc: '2.0',
			id: 7,
			method: 'elicitation/create',
			params: { message: 'Who are you?', requestedSchema: schema },
		})
		await h.settle()
		expect(seen).toMatchObject({ serverName: 'fake', message: 'Who are you?' })
		expect(h.reply(7)?.result).toEqual({ action: 'accept', content: { name: 'Ada' } })
	})

	it('sends decline and cancel without content', async () => {
		const answers: MCPElicitationResult[] = [{ action: 'decline' }, { action: 'cancel' }]
		const h = setup(async () => answers.shift() as MCPElicitationResult)
		await h.client.connect()
		for (const id of [1, 2]) {
			h.receive({
				jsonrpc: '2.0',
				id,
				method: 'elicitation/create',
				params: { message: 'm', requestedSchema: schema },
			})
			await h.settle()
		}
		expect(h.reply(1)?.result).toEqual({ action: 'decline' })
		expect(h.reply(2)?.result).toEqual({ action: 'cancel' })
	})

	it('answers cancel when the handler throws', async () => {
		const h = setup(async () => {
			throw new Error('no screen')
		})
		await h.client.connect()
		h.receive({
			jsonrpc: '2.0',
			id: 3,
			method: 'elicitation/create',
			params: { message: 'm', requestedSchema: schema },
		})
		await h.settle()
		expect(h.reply(3)?.result).toEqual({ action: 'cancel' })
	})

	it('refuses url mode as invalid params without asking anyone', async () => {
		let asked = false
		const h = setup(async () => {
			asked = true
			return { action: 'decline' }
		})
		await h.client.connect()
		h.receive({
			jsonrpc: '2.0',
			id: 4,
			method: 'elicitation/create',
			params: { mode: 'url', message: 'm', url: 'https://example.com', elicitationId: 'e' },
		})
		await h.settle()
		expect(asked).toBe(false)
		expect(h.reply(4)?.error?.code).toBe(-32602)
	})

	it('stops waiting and sends nothing when the server withdraws the request', async () => {
		let signal: AbortSignal | undefined
		let release: (() => void) | undefined
		const h = setup(async (_request, context) => {
			signal = context.signal
			await new Promise<void>((resolve) => {
				release = resolve
			})
			return { action: 'accept', content: { name: 'late' } }
		})
		await h.client.connect()
		h.receive({
			jsonrpc: '2.0',
			id: 5,
			method: 'elicitation/create',
			params: { message: 'm', requestedSchema: schema },
		})
		await h.settle()
		h.receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5 } })
		expect(signal?.aborted).toBe(true)
		release?.()
		await h.settle()
		expect(h.reply(5)).toBeUndefined()
	})

	it('still declines the request as an unknown method when no handler is set', async () => {
		const h = setup()
		await h.client.connect()
		h.receive({
			jsonrpc: '2.0',
			id: 6,
			method: 'elicitation/create',
			params: { message: 'm', requestedSchema: schema },
		})
		await h.settle()
		expect(h.reply(6)?.error?.code).toBe(-32601)
	})
})
