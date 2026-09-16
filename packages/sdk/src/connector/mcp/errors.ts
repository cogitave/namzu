import type { MCPJsonRpcError } from '../../types/connector/index.js'

/**
 * The 2026-07-28 error codes a modern MCP server answers with. Kept private
 * to this module: callers narrow on the predicates below rather than
 * comparing magic numbers, so era negotiation, header recovery and the
 * capability path never need to know the numbers themselves.
 */
const UNSUPPORTED_PROTOCOL_VERSION_CODE = -32022
const MISSING_REQUIRED_CLIENT_CAPABILITY_CODE = -32021
const HEADER_MISMATCH_CODE = -32020

/**
 * A JSON-RPC error reply from an MCP peer, with its `code` and `data`
 * preserved.
 *
 * `MCPClient.handleMessage` used to flatten every error reply into
 * `new Error('MCP error {code}: {message}')`, which threw away the one
 * thing a caller needs to react to it programmatically. Era negotiation
 * reads `code === -32022` and `data.supported`; header recovery reads
 * `-32020`; the capability path reads `-32021` and `data.requiredCapabilities`.
 * None of that is recoverable from a formatted string.
 *
 * A subclass of `Error`, never a replacement: every existing catch site that
 * treats the rejection as a plain `Error` keeps working unchanged, and
 * `.message` keeps its original `MCP error {code}: {message}` text so no
 * existing log line or string-matching test is disturbed.
 */
export class MCPProtocolError extends Error {
	readonly code: number
	readonly data?: unknown

	constructor(code: number, message: string, data?: unknown) {
		super(`MCP error ${code}: ${message}`)
		this.name = 'MCPProtocolError'
		this.code = code
		this.data = data
	}
}

/**
 * A JSON-RPC error reply whose `code` was missing or not an integer.
 *
 * A well-formed peer never sends this; a malformed one must not be mistaken
 * for a recognized protocol error, because era negotiation and the recovery
 * paths key their fallback behaviour on exactly which modern error code (or
 * none) came back. Named distinctly from `MCPProtocolError` so that no
 * `is*Error` predicate below can ever match it.
 */
export class MCPMalformedErrorReplyError extends Error {
	constructor(receivedCode: unknown, message: unknown) {
		super(`MCP error reply had a malformed code (${JSON.stringify(receivedCode)}): ${message}`)
		this.name = 'MCPMalformedErrorReplyError'
	}
}

/**
 * An HTTP response that was not a success, with the body it carried.
 *
 * The body is the reason this type exists. A status alone cannot tell a
 * legacy origin apart from a modern one: a modern server answers an unknown
 * method with `404` and a JSON-RPC `-32601` body specifically so a client
 * can distinguish it from the `404` of a server that has never heard of the
 * modern protocol. Discarding the body — which this transport used to do —
 * makes that distinction unreachable and turns every `404` into a fallback.
 *
 * `.message` is unchanged from the plain `Error` this replaces, so existing
 * logs and assertions that match on the text are undisturbed.
 */
export class MCPHttpStatusError extends Error {
	readonly status: number
	readonly statusText: string
	readonly bodyText: string

	constructor(where: string, status: number, statusText: string, bodyText: string) {
		super(`${where}: HTTP ${status}: ${statusText}`)
		this.name = 'MCPHttpStatusError'
		this.status = status
		this.statusText = statusText
		this.bodyText = bodyText
	}
}

/**
 * Build the rejection reason for a JSON-RPC error reply.
 *
 * The wire message is cast to `MCPJsonRpcMessage` at the transport boundary
 * without validation (see `JSON.parse(...) as MCPJsonRpcMessage` in
 * `stdio.ts`, `http-sse.ts`, `streamable-http.ts`), so `error.code` is only
 * a `number` by declared type — a misbehaving peer can still send anything.
 * Guarding here, once, keeps that distrust out of `handleMessage`.
 */
export function protocolErrorFromReply(error: MCPJsonRpcError): Error {
	const code: unknown = error.code
	if (typeof code !== 'number' || !Number.isInteger(code)) {
		return new MCPMalformedErrorReplyError(code, error.message)
	}
	return new MCPProtocolError(code, error.message, error.data)
}

/** A modern server answered that it does not speak the requested protocol version. */
export function isUnsupportedProtocolVersionError(error: unknown): error is MCPProtocolError {
	return error instanceof MCPProtocolError && error.code === UNSUPPORTED_PROTOCOL_VERSION_CODE
}

/** A modern server answered that this client lacks a capability the request required. */
export function isMissingRequiredClientCapabilityError(error: unknown): error is MCPProtocolError {
	return error instanceof MCPProtocolError && error.code === MISSING_REQUIRED_CLIENT_CAPABILITY_CODE
}

/** A modern server rejected a request's `Mcp-Param-*` headers as stale against its current schema. */
export function isHeaderMismatchError(error: unknown): error is MCPProtocolError {
	return error instanceof MCPProtocolError && error.code === HEADER_MISMATCH_CODE
}
