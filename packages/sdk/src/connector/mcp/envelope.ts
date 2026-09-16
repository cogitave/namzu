import {
	MCP_META_CLIENT_CAPABILITIES,
	MCP_META_CLIENT_INFO,
	MCP_META_PROTOCOL_VERSION,
	MCP_METHOD_HEADER,
	MCP_NAME_HEADER,
	MCP_NAME_HEADER_METHODS,
	MCP_PROTOCOL_VERSION_HEADER,
} from '../../constants/mcp/index.js'
import type { MCPClientCapabilities, MCPInputRequest, McpEra } from '../../types/connector/index.js'
import { MCPInvalidResultTypeError } from './errors.js'
import { type McpParamHeaderBinding, mcpParamHeaderValues } from './x-mcp-header.js'

/**
 * The revision that introduced the `MCP-Protocol-Version` header.
 *
 * Sending it to a server that negotiated an older legacy version is
 * off-spec — the header did not exist yet, so an older server has no
 * defined way to interpret it. Compared as a plain string: every version
 * this client speaks is a `YYYY-MM-DD` literal, so lexicographic order
 * equals chronological order.
 */
const MCP_PROTOCOL_VERSION_HEADER_SINCE = '2025-06-18'

/**
 * The marker a header value is wrapped in when its bytes cannot be written
 * into an HTTP field verbatim: `=?base64?{value}?=`.
 *
 * Lowercase and case-sensitive, per the spec — `=?BASE64?…?=` is a
 * different string and is NOT a sentinel.
 */
const BASE64_SENTINEL_PREFIX = '=?base64?'
const BASE64_SENTINEL_SUFFIX = '?='

/**
 * A value that can be written into an HTTP field verbatim: printable
 * US-ASCII only, and no leading or trailing space that a parser is free to
 * strip back off.
 *
 * Deliberately narrower than RFC 9110's field-value grammar, which also
 * admits HTAB and obs-text. A tab survives the wire but not every
 * intermediary, and the sentinel below costs four bytes plus base64 — the
 * cheap, always-correct answer for anything that is not plainly safe.
 */
const PLAIN_HEADER_VALUE = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/

/**
 * Already wrapped, or written to look as if it were.
 *
 * The spec states the test as a start/end check on the WHOLE value —
 * clients must also base64-encode a plain-ASCII value that "starts with
 * `=?base64?` and ends with `?=`" — not as a well-formedness check on what
 * sits between the markers. Written that way here on purpose: a tighter
 * test that forbids an interior `?` passes `=?base64?a?b?=` through
 * verbatim, and a server applying the spec's own rule then tries to decode
 * `a?b` and rejects the request with `-32020`. Over-wrapping a value costs
 * a few bytes and always survives as itself; under-wrapping one loses it.
 */
function looksLikeSentinel(value: string): boolean {
	return value.startsWith(BASE64_SENTINEL_PREFIX) && value.endsWith(BASE64_SENTINEL_SUFFIX)
}

/**
 * Write one value into a header field, wrapping it in the base64 sentinel
 * when it cannot go verbatim.
 *
 * Two cases need the wrapper, and the second is the one that is easy to
 * miss: a value whose bytes are not header-safe (anything non-ASCII, a
 * newline, a control character), and a value that IS header-safe but
 * already reads as a sentinel. Sending `=?base64?x?=` unwrapped would have
 * the server decode a string the caller meant literally, so a plain value
 * that collides with the marker is wrapped precisely so it survives as
 * itself.
 */
export function encodeMcpHeaderValue(value: string): string {
	if (PLAIN_HEADER_VALUE.test(value) && !looksLikeSentinel(value)) return value
	const encoded = Buffer.from(value, 'utf-8').toString('base64')
	return `${BASE64_SENTINEL_PREFIX}${encoded}${BASE64_SENTINEL_SUFFIX}`
}

/** What a request needs in order to be written for a given era. */
export interface McpEnvelopeInput {
	/** `undefined` before an era has been resolved — `connect()`'s own probe. */
	readonly era: McpEra | undefined
	readonly method: string
	readonly params?: Record<string, unknown>
	/** Announced in `_meta` on a modern request. Omitted when absent. */
	readonly clientInfo?: { readonly name: string; readonly version: string }
	/** Announced in `_meta` on a modern request. `{}` is the honest default. */
	readonly capabilities?: MCPClientCapabilities
	/**
	 * The `x-mcp-header` bindings of the tool this request calls, validated
	 * out of its `inputSchema`.
	 *
	 * Only `tools/call` has any, and only on a transport that mirrors them:
	 * the values are read from `params.arguments`, and the spec conditions
	 * the whole feature on Streamable HTTP. Empty or absent everywhere else.
	 */
	readonly paramHeaders?: readonly McpParamHeaderBinding[]
}

/** One request's body and the headers that mirror it. */
export interface McpEnvelope {
	readonly params: Record<string, unknown> | undefined
	readonly headers: Record<string, string>
}

/**
 * Produce a request's `params` and its headers together, for one era.
 *
 * This function exists so that the `MCP-Protocol-Version` header and
 * `_meta['io.modelcontextprotocol/protocolVersion']` are written from ONE
 * local variable, one line apart. The alternative — building them in the
 * client and the transport respectively and then asserting somewhere that
 * they agree — makes a mismatched pair constructible and then tries to
 * catch it; here there is no expression that can produce one.
 *
 * Pure, and the highest-value unit-test target in the modern era: every
 * wire-format decision a modern request makes is visible in its return
 * value without a socket, a transport or a server.
 */
export function buildEnvelope(input: McpEnvelopeInput): McpEnvelope {
	const { era, method, params } = input

	// Before an era is resolved — and on a legacy era older than the header
	// itself — a request is written exactly as it was before the modern era
	// existed: untouched params, no headers of our own.
	if (era === undefined) return { params, headers: {} }

	if (era.kind === 'legacy') {
		const headers: Record<string, string> =
			era.version >= MCP_PROTOCOL_VERSION_HEADER_SINCE
				? { [MCP_PROTOCOL_VERSION_HEADER]: era.version }
				: {}
		return { params, headers }
	}

	// The one variable. Everything below reads `protocolVersion`; nothing
	// below reads `era.version` again.
	const protocolVersion = era.version

	const meta: Record<string, unknown> = {
		...(params?._meta as Record<string, unknown> | undefined),
		[MCP_META_PROTOCOL_VERSION]: protocolVersion,
		// REQUIRED even when empty: a server reads this to decide what it may
		// ask of us, and an absent key is not the same claim as "nothing".
		[MCP_META_CLIENT_CAPABILITIES]: input.capabilities ?? {},
	}
	if (input.clientInfo) meta[MCP_META_CLIENT_INFO] = input.clientInfo

	const headers: Record<string, string> = {
		[MCP_PROTOCOL_VERSION_HEADER]: protocolVersion,
		[MCP_METHOD_HEADER]: method,
	}

	const nameSource = MCP_NAME_HEADER_METHODS[method]
	if (nameSource !== undefined) {
		const target = params?.[nameSource]
		if (typeof target === 'string' && target.length > 0) {
			headers[MCP_NAME_HEADER] = encodeMcpHeaderValue(target)
		}
	}

	// Mirrored from the SAME `params` object this envelope returns, for the
	// same reason the protocol version above is written from one variable: a
	// server rejects a header that disagrees with the body it mirrors, so
	// the two must not be readable from two places that could drift apart.
	if (input.paramHeaders !== undefined && input.paramHeaders.length > 0) {
		for (const [name, value] of Object.entries(
			mcpParamHeaderValues(input.paramHeaders, params?.arguments),
		)) {
			headers[name] = encodeMcpHeaderValue(value)
		}
	}

	return { params: { ...params, _meta: meta }, headers }
}

/** A JSON-RPC result read past the MRTR `resultType` envelope. */
export type MCPDecodedResult =
	| { readonly kind: 'complete'; readonly result: unknown }
	| {
			readonly kind: 'input_required'
			readonly inputRequests?: readonly MCPInputRequest[]
			readonly requestState?: string
	  }

/** The only `resultType` values this client recognizes. */
const KNOWN_RESULT_TYPES = new Set(['complete', 'input_required'])

/**
 * Read a JSON-RPC result past its `resultType` envelope.
 *
 * Absent `resultType` is `complete` — every legacy result, and every modern
 * result before MRTR, carries none, and the spec's own words are that
 * clients "MUST treat an absent resultType as complete". An explicit
 * `"complete"` reads the same way. Anything else recognized becomes the
 * `input_required` shape; anything unrecognized is refused, per the spec's
 * other MUST: "A resultType of any value unrecognized by the client MUST be
 * considered invalid." There is deliberately no third, permissive outcome —
 * an invalid `resultType` is not a value a caller should be able to read
 * past by accident, so this throws rather than returning an error variant.
 *
 * Pure: given the same `raw`, always the same outcome, no I/O.
 *
 * `inputRequests` entries are kept only when they at least name a `method`
 * — the one field this client reads — so a malformed entry from a
 * non-conforming server cannot be mistaken for the shape it should have
 * had. `requestState` is read only as a `string` and is otherwise carried
 * completely opaquely: this function does not parse it, and neither does
 * anything that calls it.
 */
export function decodeResult(raw: unknown): MCPDecodedResult {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { kind: 'complete', result: raw }
	}
	const record = raw as Record<string, unknown>
	const resultType = record.resultType
	if (resultType === undefined) return { kind: 'complete', result: raw }
	if (typeof resultType !== 'string' || !KNOWN_RESULT_TYPES.has(resultType)) {
		throw new MCPInvalidResultTypeError(resultType)
	}
	if (resultType === 'complete') return { kind: 'complete', result: raw }

	const inputRequests = Array.isArray(record.inputRequests)
		? (record.inputRequests as unknown[]).filter(
				(item): item is MCPInputRequest =>
					typeof item === 'object' &&
					item !== null &&
					typeof (item as { method?: unknown }).method === 'string',
			)
		: undefined
	const requestState = typeof record.requestState === 'string' ? record.requestState : undefined
	return { kind: 'input_required', inputRequests, requestState }
}
