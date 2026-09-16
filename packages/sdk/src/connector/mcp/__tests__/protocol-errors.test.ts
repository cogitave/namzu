import { describe, expect, it } from 'vitest'

import type {
	MCPJsonRpcMessage,
	MCPTransport,
	MCPTransportUnion,
} from '../../../types/connector/index.js'
import { MCPClient } from '../client.js'
import {
	MCPProtocolError,
	isHeaderMismatchError,
	isMissingRequiredClientCapabilityError,
	isUnsupportedProtocolVersionError,
} from '../errors.js'

/**
 * `MCPClient.handleMessage` used to flatten a JSON-RPC error reply into
 * `new Error('MCP error {code}: {message}')`, discarding the numeric `code`
 * and the `data` payload. Era negotiation, header recovery and the
 * capability path all need to read those back out — this is the seam that
 * makes them reachable at all.
 */

interface Harness {
	client: MCPClient
	sent: MCPJsonRpcMessage[]
	/** Deliver a frame as if the server sent it. */
	receive(msg: MCPJsonRpcMessage): void
	failTransport(err: Error): void
}

function harness(opts: { requestTimeoutMs?: number } = {}): Harness {
	const sent: MCPJsonRpcMessage[] = []
	let onMessage: ((m: MCPJsonRpcMessage) => void) | undefined
	let onError: ((err: Error) => void) | undefined

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
						result: { serverInfo: { name: 'fake', version: '1' }, capabilities: {} },
					}),
				)
			}
			// Every other request is left unanswered; tests drive its outcome
			// explicitly via `receive` or `failTransport`.
		},
		onMessage: (h) => {
			onMessage = h
		},
		onClose: () => {},
		onError: (h) => {
			onError = h
		},
	}

	const client = new MCPClient({
		serverName: 'fake',
		transport: { type: 'stdio', command: 'noop' } as MCPTransportUnion,
		...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
	})
	;(client as unknown as { transport: MCPTransport }).transport = transport

	return {
		client,
		sent,
		receive: (msg) => onMessage?.(msg),
		failTransport: (err) => onError?.(err),
	}
}

/** Send `tools/list` and answer its actual request id with the given error frame. */
async function rejectListToolsWith(
	h: Harness,
	error: NonNullable<MCPJsonRpcMessage['error']>,
): Promise<unknown> {
	const pending = h.client.listTools()
	queueMicrotask(() => {
		const request = h.sent.find((m) => m.method === 'tools/list')
		if (!request) throw new Error('expected a tools/list request to have been sent')
		h.receive({ jsonrpc: '2.0', id: request.id, error })
	})
	return pending
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise
		throw new Error('expected the promise to reject')
	} catch (err) {
		return err
	}
}

describe('MCP protocol errors preserve code and data', () => {
	it('rejects with the numeric code and the exact data.supported array', async () => {
		const h = harness()
		await h.client.connect()

		const supported = ['2026-07-28', '2025-11-25']
		const caught = await catchError(
			rejectListToolsWith(h, {
				code: -32022,
				message: 'Unsupported protocol version',
				data: { supported },
			}),
		)

		expect(caught).toBeInstanceOf(MCPProtocolError)
		const err = caught as MCPProtocolError
		expect(err.code).toBe(-32022)
		expect((err.data as { supported: string[] }).supported).toBe(supported)
	})

	it('keeps .message in the original "MCP error {code}: {message}" form', async () => {
		const h = harness()
		await h.client.connect()

		const caught = await catchError(
			rejectListToolsWith(h, { code: -32022, message: 'Unsupported protocol version' }),
		)

		expect((caught as Error).message).toBe('MCP error -32022: Unsupported protocol version')
	})

	it('is a plain Error to any existing catch site', async () => {
		const h = harness()
		await h.client.connect()

		const caught = await catchError(
			rejectListToolsWith(h, { code: -32020, message: 'Header mismatch' }),
		)

		expect(caught).toBeInstanceOf(Error)
	})

	const predicates = [
		{
			code: -32022,
			predicate: isUnsupportedProtocolVersionError,
			name: 'isUnsupportedProtocolVersionError',
		},
		{
			code: -32021,
			predicate: isMissingRequiredClientCapabilityError,
			name: 'isMissingRequiredClientCapabilityError',
		},
		{ code: -32020, predicate: isHeaderMismatchError, name: 'isHeaderMismatchError' },
	] as const

	it.each(predicates)('$name matches its own code and no other', async ({ code, predicate }) => {
		const h = harness()
		await h.client.connect()

		const caught = await catchError(rejectListToolsWith(h, { code, message: 'boom' }))

		for (const other of predicates) {
			expect(other.predicate(caught)).toBe(other.predicate === predicate)
		}
	})

	const dataCases = [
		{ label: 'string', data: 'plain string data' },
		{ label: 'array', data: ['a', 'b', 'c'] },
		{ label: 'null', data: null },
	]

	it.each(dataCases)(
		'data survives as $label without coercion or round-tripping',
		async ({ data }) => {
			const h = harness()
			await h.client.connect()

			const caught = await catchError(
				rejectListToolsWith(h, { code: -32020, message: 'boom', data }),
			)

			expect(caught).toBeInstanceOf(MCPProtocolError)
			expect((caught as MCPProtocolError).data).toBe(data)
		},
	)

	it('an error reply with no code rejects with a locally-named error no predicate matches', async () => {
		const h = harness()
		await h.client.connect()

		const caught = await catchError(
			rejectListToolsWith(
				h,
				// Cast past the type system: `code` is declared required, but a
				// misbehaving peer can omit it, and that must still be handled.
				{ message: 'no code here' } as unknown as NonNullable<MCPJsonRpcMessage['error']>,
			),
		)

		expect(caught).toBeInstanceOf(Error)
		expect(caught).not.toBeInstanceOf(MCPProtocolError)
		expect((caught as Error).name).toBe('MCPMalformedErrorReplyError')
		for (const { predicate } of predicates) {
			expect(predicate(caught)).toBe(false)
		}
	})

	it('a non-integer code rejects with the same locally-named error', async () => {
		const h = harness()
		await h.client.connect()

		const caught = await catchError(
			rejectListToolsWith(h, { code: 1.5, message: 'fractional code' }),
		)

		expect(caught).not.toBeInstanceOf(MCPProtocolError)
		expect((caught as Error).name).toBe('MCPMalformedErrorReplyError')
	})

	it('never constructs an MCPProtocolError for a local request timeout', async () => {
		const h = harness({ requestTimeoutMs: 20 })
		await h.client.connect()

		const caught = await catchError(h.client.listTools())

		expect(caught).not.toBeInstanceOf(MCPProtocolError)
	})

	it('never constructs an MCPProtocolError for a transport failure', async () => {
		const h = harness({ requestTimeoutMs: 10_000 })
		await h.client.connect()

		const pending = h.client.listTools()
		h.failTransport(new Error('broken pipe'))

		const caught = await catchError(pending)

		expect(caught).not.toBeInstanceOf(MCPProtocolError)
	})
})
