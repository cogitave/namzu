import {
	JSON_RPC_METHOD_NOT_FOUND,
	MCP_LEGACY_VERSIONS,
	MCP_META_SERVER_INFO,
	MCP_MODERN_HTTP_FALLBACK_STATUSES,
	MCP_MODERN_VERSIONS,
	MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from '../../constants/mcp/index.js'
import type {
	MCPDiscoverResult,
	MCPEraCache,
	MCPJsonRpcMessage,
	MCPTransportUnion,
	McpEra,
	McpLegacyVersion,
	McpModernVersion,
} from '../../types/connector/index.js'
import {
	MCPHttpStatusError,
	MCPProtocolError,
	isHeaderMismatchError,
	isMissingRequiredClientCapabilityError,
	isUnsupportedProtocolVersionError,
	protocolErrorFromReply,
} from './errors.js'

/**
 * Is this the answer of a server that speaks the modern protocol?
 *
 * The spec is explicit that a fallback MUST NOT be keyed to one specific
 * error code, because a legacy server refuses an unknown method with
 * whatever its implementation happens to use — commonly `-32601`, commonly
 * `-32602`, sometimes something else entirely, sometimes silence. So the
 * question is never "was this `-32601`?"; it is "did the peer answer in a
 * vocabulary only a modern server has?" — which is what these three codes
 * are. Everything else, including a code this client has never seen, means
 * fall back.
 */
export function isRecognizedModernError(error: unknown): error is MCPProtocolError {
	return (
		isUnsupportedProtocolVersionError(error) ||
		isMissingRequiredClientCapabilityError(error) ||
		isHeaderMismatchError(error)
	)
}

/**
 * Read a failed HTTP response for evidence of a modern server.
 *
 * `400`, `404` and `405` are the statuses a legacy origin answers a modern
 * request with — and also the statuses a MODERN origin uses for a request
 * it understands but will not serve. The body decides. A `404` whose body
 * is a JSON-RPC `-32601` is a modern server saying "no such method", which
 * the spec calls out precisely so it is not mistaken for the `404` of an
 * origin that has never heard of the protocol.
 *
 * `-32601` counts ONLY on a `404`. On a `400` or `405` it is an ordinary
 * unimplemented-method answer that any server of any era can send, and
 * reading it as proof of modernity there would strand this client on a
 * legacy origin with no way back.
 */
export function classifyModernHttpFailure(
	status: number,
	bodyText: string,
): { readonly kind: 'modern'; readonly error: MCPProtocolError } | { readonly kind: 'legacy' } {
	if (!MCP_MODERN_HTTP_FALLBACK_STATUSES.includes(status)) return { kind: 'legacy' }

	let parsed: unknown
	try {
		parsed = JSON.parse(bodyText)
	} catch {
		// An HTML error page, an empty body, a proxy's plain-text notice:
		// none of them are a server answering in JSON-RPC at all.
		return { kind: 'legacy' }
	}
	if (typeof parsed !== 'object' || parsed === null) return { kind: 'legacy' }

	const error = (parsed as MCPJsonRpcMessage).error
	if (!error) return { kind: 'legacy' }
	const reason = protocolErrorFromReply(error)
	if (isRecognizedModernError(reason)) return { kind: 'modern', error: reason }
	if (
		status === 404 &&
		reason instanceof MCPProtocolError &&
		reason.code === JSON_RPC_METHOD_NOT_FOUND
	) {
		return { kind: 'modern', error: reason }
	}
	return { kind: 'legacy' }
}

/** A cache that remembers nothing outside this object. */
export function createMcpEraCache(): MCPEraCache {
	const entries = new Map<string, McpEra>()
	return {
		get: (key) => entries.get(key),
		set: (key, era) => {
			entries.set(key, era)
		},
		delete: (key) => {
			entries.delete(key)
		},
	}
}

/**
 * The cache every `MCPClient` shares unless it was given its own.
 *
 * Process-wide on purpose: two clients reaching the same origin should not
 * each pay a probe. Injectable on purpose too — a suite that shared this
 * one would leak era state between cases and become order-dependent, which
 * is the failure mode a conformance suite can least afford.
 */
export const defaultMcpEraCache: MCPEraCache = createMcpEraCache()

/**
 * What a cached era belongs to: an HTTP origin, or a stdio process
 * identity.
 *
 * Path and query are deliberately dropped from an HTTP URL. Era is a
 * property of the server behind the origin, not of one endpoint on it, and
 * keying per URL would re-probe every path of the same deployment.
 *
 * Two things the key deliberately does and does not fold together:
 *
 * - `streamable_http` and `streamable-http` are two spellings of ONE
 *   transport, so they key together. An origin probed under one spelling is
 *   the same origin under the other, and keying them apart would probe it
 *   twice and let one half of the process believe something the other half
 *   had already disproved.
 * - `http-sse` keys APART from those two, on the same origin. It is the
 *   2024-11-05 transport and is never probed at all, so it records a legacy
 *   era it never tested; a Streamable HTTP client reading that entry would
 *   skip its own probe on the strength of an answer nobody asked for.
 */
export function mcpEraCacheKey(transport: MCPTransportUnion): string {
	if (transport.type === 'stdio') {
		// JSON rather than a joined string: an argument containing the
		// separator would otherwise make two different commands share a key.
		// `cwd` is part of the process identity because a relative command or
		// script path resolves against it — `node ./dist/server.js` run in two
		// directories is two servers, and they need not be the same revision.
		// `env` is not: it is where credentials live, and a key is a string
		// this process keeps in a Map for its lifetime.
		return `stdio ${JSON.stringify([transport.cwd ?? '', transport.command, ...(transport.args ?? [])])}`
	}
	const family = transport.type === 'http-sse' ? 'http-sse' : 'streamable-http'
	try {
		return `${family} ${new URL(transport.url).origin}`
	} catch {
		// A URL this client cannot parse is one the transport will fail on
		// anyway; keying by the raw string keeps this function total.
		return `${family} ${transport.url}`
	}
}

/** What one probe round trip came back with. */
export type McpEraProbeAnswer =
	| { readonly kind: 'result'; readonly result: unknown }
	| { readonly kind: 'error'; readonly error: unknown }
	| { readonly kind: 'timeout' }

/**
 * Send `server/discover` at one modern version and report what came back,
 * without throwing.
 *
 * A timeout is an ANSWER here, not a failure: the stdio spec says in so
 * many words that a legacy server may simply not respond, so silence is
 * evidence about the era rather than an error to propagate.
 */
export type McpEraProbe = (version: McpModernVersion) => Promise<McpEraProbeAnswer>

export interface McpEraResolution {
	readonly era: McpEra
	/** Present only when a modern probe actually returned a `DiscoverResult`. */
	readonly discover?: MCPDiscoverResult
	/** Probe round trips this resolution spent. `0` when the cache answered. */
	readonly probes: number
	readonly fromCache: boolean
}

export interface McpEraResolutionInput {
	readonly probe: McpEraProbe
	readonly cache: MCPEraCache
	readonly key: string
	/**
	 * `false` for the 2024-11-05 HTTP+SSE transport, which is a legacy
	 * transport by definition — an origin that speaks it is not a modern
	 * origin, and probing it would spend a round trip to learn something the
	 * transport choice already said.
	 */
	readonly probeSupported: boolean
	/** Named in a refusal so the failure says who could not agree with whom. */
	readonly serverName: string
}

const NEWEST_LEGACY: McpLegacyVersion = MCP_LEGACY_VERSIONS[0] as McpLegacyVersion
const NEWEST_MODERN: McpModernVersion = MCP_MODERN_VERSIONS[0] as McpModernVersion

const LEGACY_ERA: McpEra = { kind: 'legacy', version: NEWEST_LEGACY }

function isModernVersion(version: string): version is McpModernVersion {
	return (MCP_MODERN_VERSIONS as readonly string[]).includes(version)
}

/**
 * The newest version both sides can speak, or `undefined` when there is
 * none.
 *
 * Intersection, never "take the server's newest": offering a version this
 * client has not implemented produces a malformed exchange later instead of
 * a clean negotiation failure now.
 */
function newestMutuallySupported(offered: readonly unknown[]): string | undefined {
	const mutual = offered.filter(
		(version): version is string =>
			typeof version === 'string' && MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(version),
	)
	// Every version is a `YYYY-MM-DD` literal, so lexicographic order is
	// chronological order.
	return mutual.sort().at(-1)
}

function supportedVersionsFrom(data: unknown): readonly unknown[] {
	const supported = (data as { supported?: unknown } | undefined)?.supported
	return Array.isArray(supported) ? supported : []
}

/**
 * Is this success reply actually a `DiscoverResult`?
 *
 * Strict on purpose. The spec says a `2xx` means modern, but a `2xx` whose
 * body is not a discover result is not evidence of anything — it is a
 * legacy server that answers unknown methods with `{}` rather than an
 * error, and treating that as a modern origin would leave the client
 * sending `_meta` to a peer that has never heard of it. A reply with no
 * version list is not proof, so it is not taken as proof.
 */
function asDiscoverResult(result: unknown): MCPDiscoverResult | undefined {
	if (typeof result !== 'object' || result === null) return undefined
	const candidate = result as MCPDiscoverResult
	if (!Array.isArray(candidate.supportedVersions)) return undefined
	if (candidate.supportedVersions.length === 0) return undefined
	return candidate
}

/** The server info a modern peer carries under the reserved `_meta` key. */
export function serverInfoFromDiscover(
	discover: MCPDiscoverResult | undefined,
): { name: string; version?: string } | undefined {
	const info = discover?._meta?.[MCP_META_SERVER_INFO]
	if (typeof info !== 'object' || info === null) return undefined
	const { name, version } = info as { name?: unknown; version?: unknown }
	if (typeof name !== 'string' || name.length === 0) return undefined
	return typeof version === 'string' ? { name, version } : { name }
}

function disjointVersionsError(serverName: string, offered: readonly unknown[]): Error {
	const theirs = offered.length > 0 ? offered.map((v) => String(v)).join(', ') : '(none named)'
	return new Error(
		`MCP server "${serverName}" supports no protocol version this client speaks ` +
			`(server: ${theirs}; supported: ${MCP_SUPPORTED_PROTOCOL_VERSIONS.join(', ')}).`,
	)
}

type Attempt =
	| { readonly kind: 'modern'; readonly era: McpEra; readonly discover?: MCPDiscoverResult }
	| { readonly kind: 'legacy' }
	/** A `-32022` named a version both sides speak; try that one, once. */
	| { readonly kind: 'retry'; readonly version: McpModernVersion }
	| { readonly kind: 'refuse'; readonly error: Error }

function classifyAnswer(
	answer: McpEraProbeAnswer,
	attempted: McpModernVersion,
	serverName: string,
): Attempt {
	if (answer.kind === 'timeout') return { kind: 'legacy' }

	if (answer.kind === 'result') {
		const discover = asDiscoverResult(answer.result)
		if (!discover) return { kind: 'legacy' }
		const chosen = newestMutuallySupported(discover.supportedVersions ?? [])
		if (chosen === undefined) {
			return {
				kind: 'refuse',
				error: disjointVersionsError(serverName, discover.supportedVersions ?? []),
			}
		}
		// A discover result that lists only legacy revisions is a server
		// telling us, in the modern vocabulary, that it wants the legacy
		// handshake. Believe it rather than insisting on the era its
		// answering `server/discover` implied.
		if (!isModernVersion(chosen)) return { kind: 'legacy' }
		if (chosen !== attempted) return { kind: 'retry', version: chosen }
		return { kind: 'modern', era: { kind: 'modern', version: chosen }, discover }
	}

	const { error } = answer

	if (isUnsupportedProtocolVersionError(error)) {
		const offered = supportedVersionsFrom(error.data)
		const chosen = newestMutuallySupported(offered)
		if (chosen === undefined) {
			return { kind: 'refuse', error: disjointVersionsError(serverName, offered) }
		}
		// The best both sides can do is a legacy revision, so stop probing and
		// go and shake hands — the server named the era it wants.
		if (!isModernVersion(chosen)) return { kind: 'legacy' }
		// A server that refuses the very version it lists as supported is
		// contradicting itself, and retrying the same version would be a
		// round trip spent asking a question already answered. It answered in
		// the modern vocabulary, so the era is settled at that version and
		// the request that failed is somebody else's problem to retry.
		if (chosen === attempted) {
			return { kind: 'modern', era: { kind: 'modern', version: attempted } }
		}
		return { kind: 'retry', version: chosen }
	}

	// `-32021` and `-32020` are answers only a modern server can give: it
	// understood the request and objected to its capabilities or its
	// headers. The era is settled even though this particular probe failed.
	if (isRecognizedModernError(error)) {
		return { kind: 'modern', era: { kind: 'modern', version: attempted } }
	}

	if (error instanceof MCPHttpStatusError) {
		// Authentication and authorization failures say nothing about the
		// peer's protocol era. Retrying them as a legacy initialize request
		// only hides the actual refusal and sends another request with the
		// same unusable credentials.
		if (error.status === 401 || error.status === 403) {
			return { kind: 'refuse', error }
		}
		const verdict = classifyModernHttpFailure(error.status, error.bodyText)
		if (verdict.kind === 'legacy') return { kind: 'legacy' }
		if (isUnsupportedProtocolVersionError(verdict.error)) {
			return classifyAnswer({ kind: 'error', error: verdict.error }, attempted, serverName)
		}
		return { kind: 'modern', era: { kind: 'modern', version: attempted } }
	}

	// A refused connection, a DNS failure, a malformed reply: none of these
	// say anything about the era. Falling back means the legacy handshake
	// meets the same failure and reports it in its own words, which is a
	// better error than "the probe could not decide".
	return { kind: 'legacy' }
}

/**
 * Decide which era a peer speaks, probing at most twice.
 *
 * Modern first, per the spec's own guidance and because the alternative is
 * worse than a wasted round trip: a legacy server handed an era-ambiguous
 * method processes it under legacy semantics and fails confusingly, where a
 * probe fails cleanly. The cache makes the cost one round trip per origin
 * or per command rather than one per connection.
 *
 * The two probes are NOT the same algorithm — an HTTP probe reads a status
 * and a body, a stdio probe reads a reply or a silence — but both reduce to
 * one {@link McpEraProbe} answer, so this state machine is written once and
 * neither transport carries a copy of it.
 */
export async function resolveMcpEra(input: McpEraResolutionInput): Promise<McpEraResolution> {
	const { cache, key, probe, probeSupported, serverName } = input

	if (!probeSupported) return { era: LEGACY_ERA, probes: 0, fromCache: false }

	const cached = cache.get(key)
	if (cached?.kind === 'legacy') return { era: cached, probes: 0, fromCache: true }

	const start = cached?.kind === 'modern' ? cached.version : NEWEST_MODERN
	let probes = 0

	const run = async (version: McpModernVersion): Promise<Attempt> => {
		probes++
		return classifyAnswer(await probe(version), version, serverName)
	}

	let outcome = await run(start)
	// Exactly one retry, and only ever at a version drawn from BOTH the
	// server's list and this client's. There is no loop here to run away.
	if (outcome.kind === 'retry') outcome = await run(outcome.version)
	if (outcome.kind === 'retry') outcome = { kind: 'legacy' }

	if (outcome.kind === 'refuse') throw outcome.error

	if (outcome.kind === 'modern') {
		cache.set(key, outcome.era)
		return {
			era: outcome.era,
			...(outcome.discover ? { discover: outcome.discover } : {}),
			probes,
			fromCache: false,
		}
	}

	// A cached modern answer that no longer holds is replaced rather than
	// left in place to be believed again: a stale assumption costs exactly
	// one probe, once, and the next connection goes straight to the legacy
	// handshake. The version recorded on a legacy entry is only the one this
	// client OFFERS — which revision a legacy connection settles on is
	// decided by `initialize`, every time, and is never read from here.
	cache.set(key, LEGACY_ERA)
	return { era: LEGACY_ERA, probes, fromCache: false }
}
