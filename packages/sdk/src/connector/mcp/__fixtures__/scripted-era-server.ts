/**
 * Servers that answer exactly what a test says, over both transports era
 * negotiation actually uses.
 *
 * Era resolution is the one part of this connector where the interesting
 * cases are all things a real server does WRONG, or does in an older
 * dialect: a 404 with an HTML body, a `-32602` from a server that has never
 * heard of `server/discover`, silence. None of those are reachable by
 * pointing a test at a working server, and all of them are one line here.
 *
 * Deliberately two shapes rather than one abstraction over both. The HTTP
 * probe reads a status and a body; the stdio probe reads a reply or a
 * silence. A fixture that hid that difference would hide the thing these
 * tests exist to check.
 */

import type {
	MCPFetchLike,
	MCPJsonRpcMessage,
	MCPTransport,
	MCPTransportSendOptions,
} from '../../../types/connector/index.js'

/** One HTTP request a scripted origin received. */
export interface ScriptedHttpCall {
	readonly url: string
	/** The HTTP verb. A modern origin must never see `GET` or `DELETE`. */
	readonly httpMethod: string
	readonly headers: Record<string, string>
	/** The JSON-RPC frame, or `undefined` for a body-less request. */
	readonly body: MCPJsonRpcMessage | undefined
}

/**
 * A `Promise` that never settles is a legitimate script: it is how a test
 * says "this request is still in flight", which is the only state a
 * cancellation case can be observed from.
 */
export type HttpScript = (call: ScriptedHttpCall) => Response | Promise<Response>

export interface ScriptedHttpOrigin {
	readonly fetch: MCPFetchLike
	readonly calls: ScriptedHttpCall[]
	/** The JSON-RPC methods this origin was asked for, in order. */
	methods(): string[]
}

export function scriptedHttpOrigin(script: HttpScript): ScriptedHttpOrigin {
	const calls: ScriptedHttpCall[] = []
	const fetch: MCPFetchLike = async (input, init) => {
		let body: MCPJsonRpcMessage | undefined
		if (typeof init?.body === 'string' && init.body.length > 0) {
			body = JSON.parse(init.body) as MCPJsonRpcMessage
		}
		const call: ScriptedHttpCall = {
			url: input,
			httpMethod: init?.method ?? 'GET',
			headers: { ...init?.headers },
			body,
		}
		calls.push(call)
		return await script(call)
	}
	return {
		fetch,
		calls,
		methods: () =>
			calls.map((call) => call.body?.method).filter((method): method is string => !!method),
	}
}

/**
 * What a scripted stdio server answers one frame with: a reply, or silence.
 *
 * `undefined` is not a gap in the fixture — it is the case the spec names
 * out loud for the stdio probe, where a legacy server given a method it has
 * never heard of simply says nothing and the client must decide on a
 * timeout.
 */
export type StdioScript = (message: MCPJsonRpcMessage) => MCPJsonRpcMessage | undefined

export interface ScriptedStdioServer {
	readonly transport: MCPTransport
	readonly sent: Array<{ message: MCPJsonRpcMessage; options: MCPTransportSendOptions | undefined }>
	methods(): string[]
}

export function scriptedStdioServer(script: StdioScript): ScriptedStdioServer {
	const sent: Array<{
		message: MCPJsonRpcMessage
		options: MCPTransportSendOptions | undefined
	}> = []
	let receive: ((message: MCPJsonRpcMessage) => void) | undefined

	const transport: MCPTransport = {
		connect: async () => {},
		close: async () => {},
		isConnected: () => true,
		send: async (message, options) => {
			sent.push({ message, options })
			const reply = script(message)
			// A microtask, never synchronous: a real transport's reply always
			// arrives after `send()` returns, and a fixture that resolved
			// inline would hide an ordering bug rather than expose one.
			if (reply) queueMicrotask(() => receive?.(reply))
		},
		onMessage: (handler) => {
			receive = handler
		},
		onClose: () => {},
		onError: () => {},
	}

	return {
		transport,
		sent,
		methods: () =>
			sent.map(({ message }) => message.method).filter((method): method is string => !!method),
	}
}

/** A `DiscoverResult` as a modern server sends it. */
export function discoverResult(options: {
	readonly supportedVersions: readonly string[]
	readonly capabilities?: Record<string, unknown>
	readonly serverInfo?: { name: string; version?: string }
}): Record<string, unknown> {
	return {
		supportedVersions: [...options.supportedVersions],
		capabilities: options.capabilities ?? {},
		...(options.serverInfo
			? { _meta: { 'io.modelcontextprotocol/serverInfo': options.serverInfo } }
			: {}),
	}
}

/** A `200` carrying one JSON-RPC frame. */
export function jsonRpcResponse(body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	})
}

/** A non-2xx carrying whatever a proxy, a legacy origin or a modern one sends. */
export function statusResponse(status: number, body: string, contentType = 'text/plain'): Response {
	return new Response(body, { status, headers: { 'content-type': contentType } })
}

/** A non-2xx whose body IS a JSON-RPC error — the modern origin's answer. */
export function jsonRpcStatusResponse(
	status: number,
	id: string | number | undefined,
	error: { code: number; message: string; data?: unknown },
): Response {
	return new Response(JSON.stringify({ jsonrpc: '2.0', id, error }), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
