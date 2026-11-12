/**
 * A fake MCP server that lives in the test process and speaks either the
 * newest revision (stateless, `server/discover`) or the previous one
 * (`initialize`, no `server/discover`).
 *
 * It is a `MCPTransport`, handed to `MCPClient` through `transportFactory`,
 * so there is no socket, no child process and no network. Each method is
 * answered by a handler the test supplies; the two handshakes are supplied
 * here because they are what makes a server "newest" or "previous".
 */

import type { MCPJsonRpcMessage, MCPTransport } from '../../../types/connector/index.js'
import { MCPClient } from '../client.js'
import { createMcpEraCache } from '../era.js'

export type FakeRevision = 'newest' | 'previous'

export type FakeReply =
	| { readonly result: Record<string, unknown> }
	| { readonly error: { readonly code: number; readonly message: string; readonly data?: unknown } }
	| undefined

export type FakeHandler = (message: MCPJsonRpcMessage) => FakeReply | Promise<FakeReply>

export interface FakeServerOptions {
	readonly revision: FakeRevision
	readonly capabilities?: Record<string, unknown>
	readonly handlers?: Readonly<Record<string, FakeHandler>>
}

export interface FakeServer {
	readonly transport: MCPTransport
	/** Every request or notification the client sent, in order. */
	readonly sent: MCPJsonRpcMessage[]
	/** Methods only, in order. */
	methods(): string[]
	/** Requests for one method. */
	requestsFor(method: string): MCPJsonRpcMessage[]
	/** Deliver a frame as if the server sent it unprompted. */
	push(message: MCPJsonRpcMessage): void
	/** Replace or add a handler after construction. */
	on(method: string, handler: FakeHandler): void
}

export function fakeMcpServer(options: FakeServerOptions): FakeServer {
	const sent: MCPJsonRpcMessage[] = []
	const handlers = new Map<string, FakeHandler>(Object.entries(options.handlers ?? {}))
	let receive: ((message: MCPJsonRpcMessage) => void) | undefined
	let open = false

	const handshake = (message: MCPJsonRpcMessage): FakeReply => {
		if (options.revision === 'newest') {
			if (message.method === 'server/discover') {
				return {
					result: {
						resultType: 'complete',
						supportedVersions: ['2026-07-28'],
						capabilities: options.capabilities ?? {},
						_meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fake-newest' } },
					},
				}
			}
			if (message.method === 'initialize') {
				return { error: { code: -32601, message: 'Method not found: initialize' } }
			}
		} else {
			if (message.method === 'server/discover') {
				return { error: { code: -32601, message: 'Method not found: server/discover' } }
			}
			if (message.method === 'initialize') {
				return {
					result: {
						protocolVersion: '2025-11-25',
						capabilities: options.capabilities ?? {},
						serverInfo: { name: 'fake-previous', version: '1' },
					},
				}
			}
		}
		return undefined
	}

	const transport: MCPTransport = {
		connect: async () => {
			open = true
		},
		close: async () => {
			open = false
		},
		isConnected: () => open,
		onMessage: (handler) => {
			receive = handler
		},
		onClose: () => {},
		onError: () => {},
		send: async (message, sendOptions) => {
			sendOptions?.signal?.throwIfAborted()
			sent.push(message)
			if (message.id === undefined || message.method === undefined) return
			const id = message.id
			const method = message.method
			void (async () => {
				const handler = handlers.get(method)
				const reply = handshake(message) ?? (handler ? await handler(message) : undefined)
				// Answer in a later turn, never inline: a real transport's reply
				// arrives after `send()` returned.
				await Promise.resolve()
				if (!reply) {
					receive?.({
						jsonrpc: '2.0',
						id,
						error: { code: -32601, message: `Method not found: ${method}` },
					})
					return
				}
				receive?.({ jsonrpc: '2.0', id, ...reply })
			})()
		},
	}

	return {
		transport,
		sent,
		methods: () => sent.map((m) => m.method).filter((m): m is string => !!m),
		requestsFor: (method) => sent.filter((m) => m.method === method && m.id !== undefined),
		push: (message) => receive?.(message),
		on: (method, handler) => {
			handlers.set(method, handler)
		},
	}
}

/** A client wired to a fake server, with its own era cache. */
export function clientFor(
	server: FakeServer,
	extra: Partial<ConstructorParameters<typeof MCPClient>[0]> = {},
): MCPClient {
	return new MCPClient({
		serverName: 'fake',
		transport: { type: 'stdio', command: '/not-a-program' },
		transportFactory: () => server.transport,
		eraCache: createMcpEraCache(),
		...extra,
	})
}
