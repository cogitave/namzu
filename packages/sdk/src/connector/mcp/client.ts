import type {
	MCPClientConfig,
	MCPClientState,
	MCPConnectionStatus,
	MCPContentBlock,
	MCPDiscoverResult,
	MCPEraCache,
	MCPEventListener,
	MCPInitializeResult,
	MCPJsonRpcMessage,
	MCPLifecycleEvent,
	MCPPromptDefinition,
	MCPPromptMessage,
	MCPRequestOptions,
	MCPResource,
	MCPResourceTemplate,
	MCPServerCapabilities,
	MCPToolDefinition,
	MCPToolResult,
	MCPTransport,
	MCPTransportUnion,
	McpEra,
	McpLegacyVersion,
	McpModernVersion,
} from '../../types/connector/index.js'
import type { MCPClientId } from '../../types/ids/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { generateMCPClientId } from '../../utils/id.js'
import type { LogAttributes } from '../../utils/log/index.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
import { validateConnectorTimeoutMs } from '../http-operation.js'
import { buildEnvelope, decodeResult } from './envelope.js'
import {
	type McpEraProbeAnswer,
	type McpEraResolution,
	classifyModernHttpFailure,
	defaultMcpEraCache,
	mcpEraCacheKey,
	resolveMcpEra,
	serverInfoFromDiscover,
} from './era.js'
import {
	MCPHttpStatusError,
	MCPInputRequiredError,
	isHeaderMismatchError,
	protocolErrorFromReply,
} from './errors.js'
import { HttpSseTransport } from './http-sse.js'
import { StdioTransport } from './stdio.js'
import { StreamableHttpTransport } from './streamable-http.js'
import { type McpParamHeaderBinding, validateMcpHeaderAnnotations } from './x-mcp-header.js'

import {
	DEFAULT_MCP_ERA_PROBE_TIMEOUT_MS,
	DEFAULT_MCP_REQUEST_TIMEOUT_MS,
	JSON_RPC_METHOD_NOT_FOUND,
	MCP_DISCOVER_METHOD,
	MCP_LEGACY_VERSIONS,
	MCP_METHOD_HEADER,
	MCP_NAME_HEADER,
	MCP_PROTOCOL_VERSION_HEADER,
	MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from '../../constants/mcp/index.js'
import { NAMZU } from '../../constants/telemetry/index.js'
import { VERSION } from '../../version.js'

/** Runaway guard for a server whose cursor never ends. */
const MAX_LIST_PAGES = 100

/** A cancellation notification must never become the next unbounded wait. */
const CANCEL_NOTIFICATION_TIMEOUT_MS = 1_000

const NAMZU_CLIENT_INFO = { name: 'namzu-sdk', version: VERSION }

/**
 * The three header names the protocol owns, lower-cased for matching.
 *
 * Protected regardless of what era the connection resolved to, and
 * regardless of whether {@link buildEnvelope} put any headers of its own on
 * THIS request. A legacy era older than `2025-06-18` sends none of its
 * own — `buildEnvelope` returns `{ headers: {} }` for it, same as an
 * unresolved era — so deriving the protected set from the era's own header
 * keys (as this used to) protected nothing there: a caller could set
 * `Mcp-Method` on a 2024-11-05 or 2025-03-26 session and it reached the
 * wire unchanged. `Mcp-Method` and `Mcp-Name` are modern-only headers
 * {@link buildEnvelope} never writes on ANY legacy connection, so that gap
 * existed on every legacy era, not only the two oldest ones. The set below
 * is fixed and total precisely so "does this era currently emit the
 * header" never again decides whether a caller can forge it.
 */
const CANONICAL_MCP_REQUEST_HEADERS = new Set(
	[MCP_PROTOCOL_VERSION_HEADER, MCP_METHOD_HEADER, MCP_NAME_HEADER].map((name) =>
		name.toLowerCase(),
	),
)

/**
 * Did the peer answer `-32020` (`HeaderMismatch`)?
 *
 * Two shapes, because a conforming server sends this one BOTH ways. The spec
 * has it arrive as `400 Bad Request` carrying the JSON-RPC error in the
 * response body, which this transport surfaces as an `MCPHttpStatusError`
 * and never as a reply; a server that answers `200` with a JSON-RPC error
 * frame produces the ordinary `MCPProtocolError` instead. Recognising only
 * the second would leave the recovery dead on exactly the path the spec
 * describes.
 */
function isHeaderMismatch(error: unknown): boolean {
	if (isHeaderMismatchError(error)) return true
	if (!(error instanceof MCPHttpStatusError)) return false
	const verdict = classifyModernHttpFailure(error.status, error.bodyText)
	return verdict.kind === 'modern' && isHeaderMismatchError(verdict.error)
}

export class MCPClient {
	readonly id: MCPClientId
	private transport: MCPTransport
	private status: MCPConnectionStatus = 'disconnected'
	private serverInfo?: { name: string; version?: string }
	private serverCapabilities?: MCPServerCapabilities
	private serverInstructions?: string
	private era?: McpEra
	private connectedAt?: number
	private error?: string
	private pendingRequests = new Map<
		string | number,
		{
			resolve: (value: unknown) => void
			reject: (reason: unknown) => void
			abort: (reason: unknown) => void
		}
	>()
	private nextRequestId = 1
	private notificationHandlers: Array<(method: string, params?: Record<string, unknown>) => void> =
		[]
	private lifecycleListeners: MCPEventListener[] = []
	/** Best-effort protocol cancellations still belong to this connection generation. */
	private cancellationControllers = new Set<AbortController>()
	private log: Logger
	private readonly config: MCPClientConfig
	private readonly requestTimeoutMs: number
	private readonly eraCache: MCPEraCache
	private readonly eraCacheKey: string
	private readonly eraProbeTimeoutMs: number
	/**
	 * What each listed tool asked to mirror into `Mcp-Param-*` headers,
	 * by tool name.
	 *
	 * Rebuilt by every `listTools()` and empty until the first one: a header
	 * is only ever written from a schema this client has seen the server
	 * publish, so a stale binding cannot outlive the listing that produced
	 * it.
	 */
	private toolParamHeaders: Map<string, readonly McpParamHeaderBinding[]> = new Map()

	constructor(config: MCPClientConfig) {
		this.config = config
		this.requestTimeoutMs = validateConnectorTimeoutMs(
			config.requestTimeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS,
			'MCPClient requestTimeoutMs',
		)
		// Never longer than one round trip's deadline: a probe IS a request,
		// and one that outlived the bound every other request is held to
		// would be a connect that hangs past its own timeout.
		this.eraProbeTimeoutMs = Math.min(
			validateConnectorTimeoutMs(
				config.eraProbeTimeoutMs ?? DEFAULT_MCP_ERA_PROBE_TIMEOUT_MS,
				'MCPClient eraProbeTimeoutMs',
			),
			this.requestTimeoutMs,
		)
		this.eraCache = config.eraCache ?? defaultMcpEraCache
		this.eraCacheKey = mcpEraCacheKey(config.transport)
		this.id = config.id ?? generateMCPClientId()
		// Built BEFORE the transport, not after: `createTransport` threads
		// `this.log` into whichever transport it constructs (LOG-10), so the
		// transport's own logger has to exist by the time that call runs.
		this.log = resolveLogger(config.logger).child({
			[SCOPE_ATTRIBUTE]: 'connector/mcp',
			[NAMZU.SERVER_ID]: config.serverName,
		})
		this.transport = this.createTransport(config.transport)
	}

	async connect(): Promise<MCPInitializeResult> {
		if (this.status === 'connected') {
			throw new Error(`MCPClient already connected to "${this.config.serverName}"`)
		}

		this.status = 'connecting'
		// Tool schemas belong to a listing, and a listing belongs to a
		// connection. Carrying bindings across a reconnect would mirror the
		// previous server's schema onto the new one's calls.
		this.toolParamHeaders = new Map()
		// A reconnect must renegotiate from scratch: the era does not belong
		// to this new handshake until this new handshake has happened. The
		// era CACHE survives — it is a memory of the peer, not of this
		// connection — so a reconnect to a known-legacy origin skips the
		// probe while still running a fresh `initialize`.
		this.era = undefined

		try {
			this.transport.onMessage((msg) => this.handleMessage(msg))
			this.transport.onClose(() => {
				this.status = 'disconnected'
				this.abortCancellations(new Error('MCP transport closed'))
				this.log.info('MCP transport closed')
				this.emitLifecycle({ type: 'mcp_client_disconnected', clientId: this.id })
				this.rejectAllPending(`MCP transport to "${this.config.serverName}" closed`)
			})
			this.transport.onError((err) => {
				this.status = 'error'
				this.abortCancellations(err)
				this.error = err.message
				this.log.error('MCP transport error', { 'exception.message': err.message })
				this.emitLifecycle({ type: 'mcp_client_error', clientId: this.id, error: err.message })
				this.rejectAllPending(`MCP transport to "${this.config.serverName}" failed: ${err.message}`)
			})

			await this.transport.connect()

			const resolution = await this.resolveEra()
			if (resolution.era.kind === 'modern') {
				return this.completeModernConnection(resolution)
			}

			const result = await this.performLegacyInitializeHandshake()

			this.status = 'connected'
			this.connectedAt = Date.now()
			this.emitLifecycle({
				type: 'mcp_client_connected',
				clientId: this.id,
				serverName: this.config.serverName,
			})
			const connectedAttributes: LogAttributes = {
				[NAMZU.SERVER_NAME]: result.serverInfo.name,
			}
			this.log.info('Connected to MCP server', connectedAttributes)

			return result
		} catch (err) {
			// A remembered era that cannot complete a handshake is a memory
			// worth forgetting: the next connect re-probes from scratch rather
			// than inheriting the assumption that just failed.
			this.eraCache.delete(this.eraCacheKey)
			this.status = 'error'
			this.error = toErrorMessage(err)
			this.log.error('MCP connection failed', { 'exception.message': this.error })
			this.emitLifecycle({ type: 'mcp_client_error', clientId: this.id, error: this.error })
			throw err
		}
	}

	/**
	 * One `initialize` round trip, offering the newest legacy version this
	 * client speaks — never a per-version waterfall. The spec's own
	 * backward-compatibility algorithm offers one version and honors
	 * whatever the server answers with; a three-step retry loop would be
	 * three times the latency for a path no server expects.
	 * `protocol-negotiation.test.ts` counts `initialize` frames so this
	 * stays true.
	 *
	 * Shared by `connect()`'s first handshake and by
	 * {@link reinitializeLegacySession}'s recovery from a `404`d session —
	 * the second call is not a special case, it is this same function run
	 * again on a connection that already exists.
	 */
	private async performLegacyInitializeHandshake(): Promise<MCPInitializeResult> {
		const offered = MCP_LEGACY_VERSIONS[0]
		const result = (await this.request('initialize', {
			protocolVersion: offered,
			capabilities: this.config.capabilities ?? {},
			clientInfo: this.config.clientInfo ?? NAMZU_CLIENT_INFO,
		})) as MCPInitializeResult

		// The server answers with the version IT will speak, which need
		// not be the one we asked for. Ignoring that answer — as this once
		// did — makes an unspeakable version look like a healthy
		// connection until something downstream breaks in a confusing
		// way. A server that omits the field entirely is tolerated and
		// treated as having accepted the offer, exactly as before this
		// broadened the set.
		const negotiated = result.protocolVersion ?? offered
		if (!MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(negotiated)) {
			throw new Error(
				`MCP server "${this.config.serverName}" negotiated protocol version "${negotiated}", ` +
					`which this client cannot speak (offered "${offered}"; supported: ${MCP_SUPPORTED_PROTOCOL_VERSIONS.join(', ')}).`,
			)
		}
		if (negotiated !== offered) {
			this.log.info('MCP server negotiated a different protocol version', {
				'namzu.connector.requested': offered,
				'namzu.connector.negotiated': negotiated,
			})
		}

		// A real modern server does not implement `initialize` at all, so a
		// success shape here naming a modern revision is a server
		// contradicting itself. Refusing is the only honest answer: the
		// alternative is recording a `legacy` era at a version that is not
		// a legacy one, which would then write a modern version number
		// onto requests carrying none of what that version requires.
		if (!(MCP_LEGACY_VERSIONS as readonly string[]).includes(negotiated)) {
			throw new Error(
				`MCP server "${this.config.serverName}" answered the legacy initialize handshake with "${negotiated}", ` +
					`which is not a legacy revision (offered "${offered}"; legacy revisions: ${MCP_LEGACY_VERSIONS.join(', ')}). ` +
					'A server that speaks that revision does not implement initialize at all.',
			)
		}
		this.era = { kind: 'legacy', version: negotiated as McpLegacyVersion }

		this.serverInfo = result.serverInfo
		this.serverCapabilities = result.capabilities
		this.serverInstructions = result.instructions

		await this.notify('notifications/initialized', {})

		return result
	}

	/**
	 * A request answered `404` on a session-bearing legacy connection: the
	 * legacy Streamable HTTP transports specify that a terminated session
	 * answers this way, and the client's remedy is to drop it and run the
	 * handshake again, exactly once, before giving up.
	 *
	 * Gated to legacy by construction, not by a flag: `hasSession()` is only
	 * ever true on a connection that completed the legacy `initialize`
	 * handshake in the first place — a modern connection never calls it (see
	 * `probeDiscover`), so `resetSession`/`hasSession` have nothing to report
	 * there.
	 */
	private isLegacySessionLostError(err: unknown): boolean {
		return (
			this.era?.kind === 'legacy' &&
			this.transport instanceof StreamableHttpTransport &&
			this.transport.hasSession() &&
			err instanceof MCPHttpStatusError &&
			err.status === 404
		)
	}

	/** Drop the stale session and run the legacy handshake again, from scratch. */
	private async reinitializeLegacySession(): Promise<void> {
		if (this.transport instanceof StreamableHttpTransport) {
			this.transport.resetSession()
		}
		await this.performLegacyInitializeHandshake()
	}

	/**
	 * `request()`, with the legacy session recovery a live connection needs
	 * that the initial handshake does not: `connect()`'s own `initialize`
	 * call has no session yet to lose, so it goes through `request()`
	 * directly and never through here.
	 *
	 * At most one recovery attempt. A retry that fails the same way is not
	 * retried again — surfacing it is more honest than masking a second
	 * genuine failure as a transient one.
	 */
	private async requestWithSessionRecovery(
		method: string,
		params: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<unknown> {
		try {
			return await this.request(method, params, options)
		} catch (err) {
			if (!this.isLegacySessionLostError(err)) throw err
			this.log.warn('MCP legacy session lost; re-initializing once before retrying', {
				'namzu.connector.server': this.config.serverName,
				'namzu.connector.method': method,
			})
			await this.reinitializeLegacySession()
			return await this.request(method, params, options)
		}
	}

	/**
	 * Which era this peer speaks, probed once and remembered per origin (or
	 * per stdio command).
	 *
	 * Modern first. The wasted round trip against a legacy server is real
	 * and is the reason the cache exists; the alternative is worse than
	 * wasted latency, because a legacy server handed an era-ambiguous method
	 * processes it under legacy semantics and fails confusingly, where a
	 * probe fails cleanly and recovers.
	 */
	private async resolveEra(): Promise<McpEraResolution> {
		const resolution = await resolveMcpEra({
			cache: this.eraCache,
			key: this.eraCacheKey,
			serverName: this.config.serverName,
			// HTTP+SSE is the 2024-11-05 transport. An origin reached through
			// it is legacy by the operator's own choice of transport, so the
			// probe would spend a round trip learning what the config said.
			probeSupported: this.config.transport.type !== 'http-sse',
			probe: (version) => this.probeDiscover(version),
		})
		this.log.debug('MCP era resolved', {
			'namzu.connector.server': this.config.serverName,
			'namzu.connector.era': resolution.era.kind,
			'namzu.connector.negotiated': resolution.era.version,
			'namzu.connector.probes': resolution.probes,
			'namzu.connector.cached': resolution.fromCache,
		})
		return resolution
	}

	/**
	 * Ask the peer to describe itself, and report silence as an answer.
	 *
	 * Deliberately NOT `request()`. A probe differs from a request in the
	 * two ways that matter: a timeout is a legitimate outcome rather than a
	 * failure — the stdio spec says in so many words that a legacy server
	 * may not respond at all — and a probe that gives up must not send
	 * `notifications/cancelled`, because the peer it would be sent to is, by
	 * hypothesis, one that did not understand the request in the first
	 * place. Everything `request()` owns about cancellation ordering is left
	 * exactly as it is rather than taught a second mode.
	 */
	private probeDiscover(version: McpModernVersion): Promise<McpEraProbeAnswer> {
		const id = this.nextRequestId++
		const envelope = buildEnvelope({
			era: { kind: 'modern', version },
			method: MCP_DISCOVER_METHOD,
			params: {},
			clientInfo: this.config.clientInfo ?? NAMZU_CLIENT_INFO,
			capabilities: this.config.capabilities ?? {},
		})
		const controller = new AbortController()

		return new Promise<McpEraProbeAnswer>((resolve) => {
			let settled = false
			const finish = (answer: McpEraProbeAnswer): void => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				if (this.pendingRequests.get(id) === entry) this.pendingRequests.delete(id)
				resolve(answer)
			}
			const entry = {
				resolve: (value: unknown) => finish({ kind: 'result', result: value }),
				reject: (reason: unknown) => finish({ kind: 'error', error: reason }),
				abort: (reason: unknown) => finish({ kind: 'error', error: reason }),
			}
			const timer = setTimeout(() => {
				controller.abort(new Error('MCP era probe timed out'))
				finish({ kind: 'timeout' })
			}, this.eraProbeTimeoutMs)
			timer.unref?.()
			this.pendingRequests.set(id, entry)

			try {
				void this.transport
					.send(
						{ jsonrpc: '2.0', id, method: MCP_DISCOVER_METHOD, params: envelope.params },
						{ signal: controller.signal, ...this.eraHeaderOptions(envelope.headers) },
					)
					.catch((err: unknown) => finish({ kind: 'error', error: err }))
			} catch (err) {
				finish({ kind: 'error', error: err })
			}
		})
	}

	/**
	 * Finish a connection that resolved modern, with no handshake at all.
	 *
	 * The modern era has no `initialize` and no `notifications/initialized`,
	 * so there is nothing here to await: the probe already carried the only
	 * round trip a modern connection needs. `MCPInitializeResult` is
	 * synthesised from the `DiscoverResult` so a host sees the same return
	 * shape whichever era resolved — the era is this client's business, not
	 * something every caller has to branch on.
	 */
	private completeModernConnection(resolution: McpEraResolution): MCPInitializeResult {
		const era = resolution.era
		if (era.kind !== 'modern') {
			// Unreachable: only `connect()` calls this, and only on the modern
			// arm. Narrowing rather than casting keeps that true by
			// construction if a second call site is ever added.
			throw new Error('completeModernConnection requires a modern era')
		}
		this.era = era
		const result = this.modernInitializeResult(era.version, resolution.discover)
		this.serverInfo = result.serverInfo
		this.serverCapabilities = result.capabilities
		this.serverInstructions = result.instructions

		this.status = 'connected'
		this.connectedAt = Date.now()
		this.emitLifecycle({
			type: 'mcp_client_connected',
			clientId: this.id,
			serverName: this.config.serverName,
		})
		const connectedAttributes: LogAttributes = {
			[NAMZU.SERVER_NAME]: result.serverInfo.name,
		}
		this.log.info('Connected to MCP server', connectedAttributes)
		return result
	}

	/**
	 * A `DiscoverResult` read as the `MCPInitializeResult` a host expects.
	 *
	 * `serverInfo` is a SHOULD on a discover result, not a MUST, and
	 * `MCPInitializeResult.serverInfo` is required — so a server that does
	 * not name itself is reported under the name the operator gave it.
	 * Inventing a placeholder like "unknown" would put a word in the
	 * server's mouth in the one field a person reads to identify it.
	 *
	 * `instructions` is left unset: the modern era has no `initialize`
	 * round trip, so there is nothing in a `DiscoverResult` to carry it.
	 */
	private modernInitializeResult(
		version: McpModernVersion,
		discover: MCPDiscoverResult | undefined,
	): MCPInitializeResult {
		return {
			protocolVersion: version,
			capabilities: discover?.capabilities ?? {},
			serverInfo: serverInfoFromDiscover(discover) ?? { name: this.config.serverName },
		}
	}

	async disconnect(): Promise<void> {
		const reason = new Error('MCPClient disconnecting')
		this.abortCancellations(reason)
		const alreadyDisconnected = this.status === 'disconnected'

		this.rejectAllPending('MCPClient disconnecting')

		await this.transport.close()
		this.status = 'disconnected'
		this.connectedAt = undefined
		if (alreadyDisconnected) return
		this.log.info('MCP client disconnected')
		this.emitLifecycle({ type: 'mcp_client_disconnected', clientId: this.id })
	}

	isConnected(): boolean {
		return this.status === 'connected'
	}

	/**
	 * Which era and exact revision the last `connect()` negotiated.
	 *
	 * `undefined` before a connection has been negotiated. Which arm it
	 * lands on is the peer's answer, not a configuration: `connect()` probes
	 * for a modern server and falls back to the legacy handshake.
	 */
	getEra(): McpEra | undefined {
		return this.era
	}

	getState(): MCPClientState {
		return {
			id: this.id,
			serverName: this.config.serverName,
			status: this.status,
			serverInfo: this.serverInfo,
			serverCapabilities: this.serverCapabilities,
			serverInstructions: this.serverInstructions,
			connectedAt: this.connectedAt,
			error: this.error,
		}
	}

	/**
	 * Every tool this server publishes that this client is willing to expose.
	 *
	 * The second clause is new and it is the first place namzu refuses
	 * something a server offered. A tool whose `inputSchema` carries an
	 * invalid `x-mcp-header` annotation is excluded from the result, with the
	 * tool name and the reason logged — the spec's requirement, and the
	 * reason it is a requirement is that the annotation names a header this
	 * client would otherwise write from a value it cannot vouch for.
	 *
	 * It lives HERE rather than in `MCPToolDiscovery` or the tool adapter
	 * because the shipping CLI calls `listTools()` directly and never
	 * touches discovery: validating one layer up would exempt the one caller
	 * that matters most.
	 */
	async listTools(options?: MCPRequestOptions): Promise<MCPToolDefinition[]> {
		this.requireConnected()
		const listed = await this.listAllPages<MCPToolDefinition>('tools/list', 'tools', options)
		return this.admitToolHeaderAnnotations(listed)
	}

	/**
	 * Call one tool, and recover once from a server that says our mirrored
	 * headers disagree with its current schema.
	 *
	 * `-32020` (`HeaderMismatch`) means the `Mcp-Param-*` headers this client
	 * wrote are missing or wrong for the schema the server holds NOW — which
	 * a server can legitimately cause by changing a tool between the listing
	 * and the call. The spec's recovery is to re-read `tools/list` and retry
	 * the request once. Exactly once: the retry goes through `request()`
	 * rather than back through this method, so a second `-32020` surfaces to
	 * the caller instead of starting a third round trip.
	 */
	async callTool(
		name: string,
		args?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<MCPToolResult> {
		this.requireConnected()
		try {
			return (await this.callToolDecoded(name, args ?? {}, options)) as MCPToolResult
		} catch (err) {
			if (!this.mirrorsParamHeaders() || !isHeaderMismatch(err)) throw err
			this.log.warn("MCP server rejected a call's mirrored headers; re-listing tools once", {
				'namzu.connector.server': this.config.serverName,
				'namzu.mcp.tool': name,
			})
			await this.listTools(options)
			return (await this.callToolDecoded(name, args ?? {}, options)) as MCPToolResult
		}
	}

	/**
	 * Does this connection mirror tool parameters into `Mcp-Param-*` headers?
	 *
	 * Conditioned on the TRANSPORT, not on the era, because that is how the
	 * spec conditions it: the feature belongs to Streamable HTTP, and a
	 * client on another transport may ignore `x-mcp-header` entirely. stdio
	 * has no headers to mirror into, and `http-sse` is the 2024-11-05
	 * transport, which predates the annotation by two years.
	 *
	 * The headers themselves are written only on a modern request — that is
	 * `buildEnvelope`'s doing, not this predicate's — but the VALIDATION runs
	 * in both eras on this transport, so a tool's admission does not silently
	 * change shape the day the server behind it stops answering `initialize`.
	 */
	private mirrorsParamHeaders(): boolean {
		const type = this.config.transport.type
		return type === 'streamable_http' || type === 'streamable-http'
	}

	/**
	 * Drop the tools whose header annotations this client will not honour,
	 * and remember what the rest asked to mirror.
	 *
	 * One malformed definition must not deny the others, which is why this
	 * filters rather than throws: a server with fifty tools and one bad
	 * annotation stays a server with forty-nine usable tools.
	 */
	private admitToolHeaderAnnotations(tools: MCPToolDefinition[]): MCPToolDefinition[] {
		if (!this.mirrorsParamHeaders()) return tools

		const bindings = new Map<string, readonly McpParamHeaderBinding[]>()
		const admitted: MCPToolDefinition[] = []
		for (const tool of tools) {
			const verdict = validateMcpHeaderAnnotations(tool?.inputSchema)
			const name = typeof tool?.name === 'string' ? tool.name : '(unnamed)'
			if (!verdict.ok) {
				this.log.warn('Excluded an MCP tool with an invalid x-mcp-header annotation', {
					'namzu.connector.server': this.config.serverName,
					'namzu.mcp.tool': name,
					'namzu.mcp.reason': verdict.reason,
				})
				continue
			}
			if (verdict.bindings.length > 0) bindings.set(name, verdict.bindings)
			admitted.push(tool)
		}
		this.toolParamHeaders = bindings
		return admitted
	}

	/**
	 * `tools/call`, resolved past the MRTR `resultType` envelope.
	 *
	 * Absent or `"complete"` is the ordinary path — unchanged from before
	 * this existed. `"input_required"` with nothing but a `requestState` is
	 * retried exactly once, echoing that state byte-for-byte under a NEW
	 * JSON-RPC id (a fresh `request()` call, which allocates one): the
	 * spec's own words are that the client MAY retry immediately when there
	 * is nothing for it to gather. Any other shape — `inputRequests` this
	 * client cannot satisfy, or a second `input_required` after the one
	 * retry — throws `MCPInputRequiredError` rather than looping or
	 * returning something that looks like success; `mcpToolToToolDefinition`
	 * catches it and turns it into a named, catchable `ToolResult` instead
	 * of letting it reach a caller as an unexplained rejection.
	 *
	 * `requestState` travels back as a top-level `requestState` param,
	 * alongside `name`/`arguments`, the same way `listAllPages` threads a
	 * `cursor` — the one continuation-style field this codebase already has
	 * a convention for.
	 */
	private async callToolDecoded(
		name: string,
		args: Record<string, unknown>,
		options: MCPRequestOptions | undefined,
	): Promise<unknown> {
		const raw = await this.requestWithSessionRecovery(
			'tools/call',
			{ name, arguments: args },
			options,
		)
		const decoded = decodeResult(raw)
		if (decoded.kind === 'complete') return decoded.result

		const unsatisfiable = decoded.inputRequests !== undefined && decoded.inputRequests.length > 0
		if (!unsatisfiable && decoded.requestState !== undefined) {
			this.log.info('MCP tool call asked for no new input; retrying once with echoed state', {
				'namzu.connector.server': this.config.serverName,
				'namzu.connector.tool': name,
			})
			const retryRaw = await this.requestWithSessionRecovery(
				'tools/call',
				{ name, arguments: args, requestState: decoded.requestState },
				options,
			)
			const retried = decodeResult(retryRaw)
			if (retried.kind === 'complete') return retried.result
			this.log.warn('MCP tool call required input again after the one automatic retry', {
				'namzu.connector.server': this.config.serverName,
				'namzu.connector.tool': name,
			})
			throw new MCPInputRequiredError(retried.inputRequests ?? [])
		}

		this.log.warn('MCP tool call requires input this client cannot supply', {
			'namzu.connector.server': this.config.serverName,
			'namzu.connector.tool': name,
			'namzu.connector.requested': (decoded.inputRequests ?? []).map((r) => r.method).join(', '),
		})
		throw new MCPInputRequiredError(decoded.inputRequests ?? [])
	}

	async listResources(options?: MCPRequestOptions): Promise<MCPResource[]> {
		this.requireConnected()
		return await this.listAllPages('resources/list', 'resources', options)
	}

	async readResource(uri: string, options?: MCPRequestOptions): Promise<MCPContentBlock[]> {
		this.requireConnected()
		const result = (await this.requestWithSessionRecovery('resources/read', { uri }, options)) as {
			contents: MCPContentBlock[]
		}
		return result.contents
	}

	/**
	 * The prompts a server publishes.
	 *
	 * A prompt is the server's own wording for a task it knows how to set
	 * up — the half of MCP that is not tools. `MCPPromptDefinition` and
	 * `MCPPromptArgument` were declared when the types were written and no
	 * method ever asked for one, so a server offering prompts had them
	 * silently ignored.
	 *
	 * Paged through the same reader as every other list, which is the point
	 * of it being generic: a server that pages its prompts does not get
	 * silently truncated to page one the way the tool list once was.
	 */
	async listPrompts(options?: MCPRequestOptions): Promise<MCPPromptDefinition[]> {
		this.requireConnected()
		return await this.listAllPages('prompts/list', 'prompts', options)
	}

	/**
	 * Fetch one prompt, with its arguments filled in.
	 *
	 * Returns the messages the SERVER composed. They are data to be shown to
	 * a model, never instructions to this client: a prompt arriving from a
	 * remote server is exactly the untrusted-content case, and treating its
	 * text as direction would let a server steer the agent by publishing a
	 * prompt nobody asked to run.
	 */
	async getPrompt(
		name: string,
		args?: Record<string, string>,
		options?: MCPRequestOptions,
	): Promise<{ description?: string; messages: MCPPromptMessage[] }> {
		this.requireConnected()
		const result = (await this.requestWithSessionRecovery(
			'prompts/get',
			{
				name,
				arguments: args ?? {},
			},
			options,
		)) as { description?: string; messages?: MCPPromptMessage[] }
		return {
			...(result.description !== undefined ? { description: result.description } : {}),
			messages: result.messages ?? [],
		}
	}

	async listResourceTemplates(options?: MCPRequestOptions): Promise<MCPResourceTemplate[]> {
		this.requireConnected()
		return await this.listAllPages('resources/templates/list', 'resourceTemplates', options)
	}

	/**
	 * Read a paged list to the end.
	 *
	 * The three list calls each sent an empty params object and returned
	 * the first page, never sending a cursor and never reading the one
	 * that came back. A server that pages its catalogue therefore
	 * contributed only its first page: the rest were never registered,
	 * never namespaced, never advertised — with no error, no warning and
	 * no drift signal, because drift compares page one against page one.
	 * The symptom is a model that does not use a tool it was told about,
	 * which reads as model incompetence rather than a client bug.
	 *
	 * The page cap is a runaway guard, not a limit anyone should reach: a
	 * server that keeps returning a cursor forever would otherwise loop
	 * until the process dies. Hitting it is loud, because a silently
	 * truncated catalogue is the failure being fixed here.
	 */
	private async listAllPages<T>(
		method: string,
		field: string,
		options?: MCPRequestOptions,
	): Promise<T[]> {
		const items: T[] = []
		let cursor: string | undefined

		for (let page = 1; ; page++) {
			const result = (await this.requestWithSessionRecovery(
				method,
				cursor === undefined ? {} : { cursor },
				options,
			)) as Record<string, unknown>

			const batch = result[field]
			if (Array.isArray(batch)) items.push(...(batch as T[]))

			const next = result.nextCursor
			if (typeof next !== 'string' || next.length === 0) return items
			if (page >= MAX_LIST_PAGES) {
				throw new Error(
					`${method} did not stop paging after ${MAX_LIST_PAGES} pages (${items.length} items so far). Refusing to keep going rather than returning a catalogue that is silently missing the rest.`,
				)
			}
			cursor = next
		}
	}

	onNotification(handler: (method: string, params?: Record<string, unknown>) => void): void {
		this.notificationHandlers.push(handler)
	}

	/**
	 * Watch this client come up, go down, or fail.
	 *
	 * `MCPLifecycleEvent` and `MCPEventListener` were declared with the rest
	 * of the MCP types and nothing ever emitted one, so a host could observe
	 * a server dying only by noticing that calls had started failing. The
	 * four transitions below already existed and already mutated `status`;
	 * this adds no state, it just says out loud what the client already
	 * knew.
	 *
	 * Returns an unsubscribe. `onNotification` above does not, which is the
	 * bug this avoids repeating: a listener that cannot be removed keeps a
	 * disposed host object alive for as long as the client lives.
	 */
	onLifecycle(listener: MCPEventListener): () => void {
		this.lifecycleListeners.push(listener)
		return () => {
			const index = this.lifecycleListeners.indexOf(listener)
			if (index >= 0) this.lifecycleListeners.splice(index, 1)
		}
	}

	/**
	 * A listener that throws must not take the transport down with it.
	 *
	 * These fire from inside transport callbacks and from the failure path
	 * of `connect`, so an exception here would surface as a connection
	 * error — blaming the server for a bug in the host's own observer.
	 */
	private emitLifecycle(event: MCPLifecycleEvent): void {
		for (const listener of this.lifecycleListeners) {
			try {
				listener(event)
			} catch (err) {
				this.log.warn('MCP lifecycle listener threw', { 'exception.message': toErrorMessage(err) })
			}
		}
	}

	private createTransport(config: MCPTransportUnion): MCPTransport {
		switch (config.type) {
			case 'stdio':
				return new StdioTransport(config, this.log)
			case 'http-sse':
				return new HttpSseTransport(config, this.log)
			case 'streamable_http':
			case 'streamable-http':
				return new StreamableHttpTransport(config, this.log)
			default:
				throw new Error(`Unsupported MCP transport type: ${(config as MCPTransportUnion).type}`)
		}
	}

	/**
	 * Send a JSON-RPC request and wait for its reply, bounded by a timer.
	 *
	 * There was no timer at all. On `streamable_http` the pending promise
	 * happened to be bounded because `send()` awaits the fetch inside an
	 * aborted scope, but on **stdio** — the default for local servers —
	 * and on `http_sse` (whose reply arrives on a separate channel) a
	 * server that wedged left the promise pending forever. Combined with
	 * an executor that awaited tools unbounded, one unresponsive MCP
	 * server hung the whole turn with no error and no `turn_failed`: not a
	 * crash, just a process that stopped.
	 */
	private request(
		method: string,
		params: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<unknown> {
		// Refuse before allocating an id or asking the transport to do work.
		options?.signal?.throwIfAborted()
		const id = this.nextRequestId++
		const envelope = buildEnvelope({
			era: this.era,
			method,
			params,
			clientInfo: this.config.clientInfo ?? NAMZU_CLIENT_INFO,
			capabilities: this.config.capabilities ?? {},
			...this.paramHeaderBindings(method, params),
		})
		const message: MCPJsonRpcMessage = {
			jsonrpc: '2.0',
			id,
			method,
			params: envelope.params,
		}
		const transportController = new AbortController()
		let issued = false
		let settled = false
		let resolvePublic!: (value: unknown) => void
		let rejectPublic!: (reason: unknown) => void
		const result = new Promise<unknown>((resolve, reject) => {
			resolvePublic = resolve
			rejectPublic = reject
		})

		type Terminal = 'response' | 'failure' | 'caller' | 'timeout' | 'transport_closed'
		const entry = {
			resolve: (value: unknown) => settle('response', value),
			reject: (reason: unknown) => settle('failure', reason),
			abort: (reason: unknown) => settle('transport_closed', reason),
		}
		const onCallerAbort = (): void => {
			settle('caller', options?.signal?.reason)
		}
		const cleanup = (): void => {
			clearTimeout(timer)
			options?.signal?.removeEventListener('abort', onCallerAbort)
			if (this.pendingRequests.get(id) === entry) this.pendingRequests.delete(id)
		}
		const settle = (terminal: Terminal, value: unknown): boolean => {
			if (settled) return false
			settled = true
			// The terminal winner owns cleanup synchronously. In particular, a
			// response delivered from inside transport.send removes the abort
			// listener before that same send call can observe a later abort.
			cleanup()

			if (terminal === 'response') {
				resolvePublic(value)
				return true
			}

			rejectPublic(value)
			if (terminal === 'caller' || terminal === 'timeout' || terminal === 'transport_closed') {
				// Latch public settlement before aborting transport. An abort listener
				// may synchronously reject send() with a generic AbortError; it no
				// longer owns this request and cannot replace the first cause.
				transportController.abort(value)
			}
			if (
				issued &&
				method !== 'initialize' &&
				(terminal === 'caller' || terminal === 'timeout') &&
				this.sendsCancellationNotification()
			) {
				this.sendCancellation(
					id,
					terminal === 'caller' ? 'Caller cancelled request' : 'Request deadline expired',
				)
			}
			return true
		}
		const settleSendFailure = (reason: unknown): void => {
			// An HTTP transport may have a deliberately shorter deadline than
			// the JSON-RPC round-trip deadline. It is still a request timeout:
			// the peer may be working after this local POST wait ended, so the
			// correlated protocol cancellation remains required.
			if (reason instanceof Error && reason.name === 'TimeoutError') {
				settle('timeout', reason)
				return
			}
			entry.reject(reason)
		}

		this.pendingRequests.set(id, entry)
		const timer = setTimeout(() => {
			const error = new Error(
				`MCP request "${method}" to "${this.config.serverName}" timed out after ${this.requestTimeoutMs}ms`,
			)
			error.name = 'TimeoutError'
			this.log.warn('MCP request timed out', {
				'namzu.connector.server': this.config.serverName,
				'namzu.connector.method': method,
				'namzu.connector.timeout_ms': this.requestTimeoutMs,
			})
			settle('timeout', error)
		}, this.requestTimeoutMs)
		options?.signal?.addEventListener('abort', onCallerAbort, { once: true })
		// AbortSignal events are not replayed. This closes the listener-install
		// race before the request is issued.
		if (options?.signal?.aborted) {
			onCallerAbort()
			return result
		}

		try {
			issued = true
			const sending = this.transport.send(message, {
				signal: transportController.signal,
				...this.requestAuthorityHeaders(envelope.headers, options),
			})
			void sending.catch((err) => {
				settleSendFailure(err)
			})
		} catch (err) {
			settleSendFailure(err)
		}

		return result
	}

	/**
	 * `{ headers: {...} }` when the era produced any, `{}` otherwise —
	 * spread into a `send()` options object so a send with no era headers
	 * (a legacy era before 2025-06-18, and everything sent before an era is
	 * resolved) gets no `headers` key at all rather than one holding an
	 * empty object.
	 */
	private eraHeaderOptions(headers: Record<string, string>): {
		headers?: Record<string, string>
	} {
		return Object.keys(headers).length > 0 ? { headers } : {}
	}

	/**
	 * `{ paramHeaders }` for a `tools/call` whose tool asked for mirrored
	 * headers, `{}` for everything else — spread into the envelope input so
	 * every other request is built from exactly the object it was built from
	 * before this existed.
	 *
	 * Read from the last listing rather than passed down from `callTool`, so
	 * the bindings are the ones that came with the schema the caller was
	 * shown, whichever call site reached `request()`.
	 */
	private paramHeaderBindings(
		method: string,
		params: Record<string, unknown>,
	): { paramHeaders?: readonly McpParamHeaderBinding[] } {
		if (method !== 'tools/call' || typeof params.name !== 'string') return {}
		const bindings = this.toolParamHeaders.get(params.name)
		return bindings === undefined ? {} : { paramHeaders: bindings }
	}

	/**
	 * `request()`'s full per-send header authority: the era's own headers
	 * from `buildEnvelope`, this call's `MCPRequestOptions.headers` merged
	 * over them — a collision resolves to the caller's value, except on the
	 * headers the protocol itself owns — and this call's `bearerToken`, if
	 * given, applied last as `Authorization` so it overrides a same-named
	 * header from either of the other two sources.
	 *
	 * **The exception.** `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name`
	 * are not decoration: each mirrors a value the same request carries in
	 * its body — the negotiated version in
	 * `_meta['io.modelcontextprotocol/protocolVersion']`, the method, the
	 * target's name — and a conforming modern server rejects a header that
	 * disagrees with what it mirrors (`-32020`, HeaderMismatch). Letting a
	 * caller's value win there would make the mismatched pair
	 * {@link buildEnvelope} exists to render unconstructible constructible
	 * again one layer up, and the failure would reach the host as an opaque
	 * 400 with nothing pointing at the header that caused it. So a caller
	 * header colliding with one of {@link CANONICAL_MCP_REQUEST_HEADERS} is
	 * refused and warn-logged, naming it — in EVERY era, including a legacy
	 * one old enough that {@link buildEnvelope} puts no headers of its own
	 * on this request. Matching ignores case, because HTTP field names are
	 * case-insensitive and `{ 'mcp-protocol-version': … }` alongside the
	 * era's `MCP-Protocol-Version` would otherwise reach the wire as one
	 * field holding both values, comma-joined.
	 *
	 * Every other header a caller sends is untouched, in both eras.
	 *
	 * `notify()` and `sendCancellation()` are internal, not caller-facing,
	 * so they carry era headers alone — only a public request the caller
	 * shaped can carry a per-call header or token.
	 *
	 * Returns `{}`, never `{ headers: undefined }`, when nothing applies, so
	 * the zero-option path stays the exact object shape `request()` sent
	 * before any of this existed.
	 */
	private requestAuthorityHeaders(
		eraHeaders: Record<string, string>,
		options?: MCPRequestOptions,
	): {
		headers?: Record<string, string>
	} {
		const hasEraHeaders = Object.keys(eraHeaders).length > 0
		if (!hasEraHeaders && !options?.headers && !options?.bearerToken) return {}
		const headers: Record<string, string> = { ...eraHeaders }
		const protocolOwned = new Set([
			...CANONICAL_MCP_REQUEST_HEADERS,
			...Object.keys(eraHeaders).map((name) => name.toLowerCase()),
		])
		for (const [name, value] of Object.entries(options?.headers ?? {})) {
			if (protocolOwned.has(name.toLowerCase())) {
				this.log.warn('Refused a per-request MCP header the protocol owns', {
					'namzu.connector.server': this.config.serverName,
					'namzu.mcp.header': name,
					'namzu.mcp.era': this.era?.kind ?? 'unresolved',
				})
				continue
			}
			headers[name] = value
		}
		if (options?.bearerToken) headers.Authorization = `Bearer ${options.bearerToken}`
		return { headers }
	}

	/**
	 * Does a cancelled request on THIS connection owe the peer a
	 * `notifications/cancelled`?
	 *
	 * Everywhere except modern Streamable HTTP, yes. There, no: closing the
	 * SSE response stream IS the cancellation signal, so the notification is
	 * a second, redundant POST — and one the spec does not ask for. stdio
	 * has no stream to close, so it still sends it, in every era.
	 *
	 * This predicate is the ONLY thing the modern era changes about
	 * cancellation. The ordering guarantees in `request()` — who owns
	 * cleanup, which cause wins, when the transport is aborted — are
	 * untouched.
	 */
	private sendsCancellationNotification(): boolean {
		if (this.era?.kind !== 'modern') return true
		return this.config.transport.type === 'stdio'
	}

	/** Ask the peer to stop without letting cleanup become another hanging request. */
	private sendCancellation(id: string | number, reason: string): void {
		const envelope = buildEnvelope({
			era: this.era,
			method: 'notifications/cancelled',
			params: { requestId: id, reason },
			clientInfo: this.config.clientInfo ?? NAMZU_CLIENT_INFO,
			capabilities: this.config.capabilities ?? {},
		})
		const controller = new AbortController()
		this.cancellationControllers.add(controller)
		const timer = setTimeout(() => {
			const error = new Error('MCP cancellation notification timed out')
			error.name = 'TimeoutError'
			controller.abort(error)
			this.cancellationControllers.delete(controller)
		}, CANCEL_NOTIFICATION_TIMEOUT_MS)
		timer.unref?.()
		let sending: Promise<void>
		try {
			sending = this.transport.send(
				{
					jsonrpc: '2.0',
					method: 'notifications/cancelled',
					params: envelope.params,
				},
				{ signal: controller.signal, ...this.eraHeaderOptions(envelope.headers) },
			)
		} catch (err) {
			clearTimeout(timer)
			this.cancellationControllers.delete(controller)
			this.log.debug('Failed to send MCP cancellation notification', {
				'exception.message': toErrorMessage(err),
			})
			return
		}
		void sending
			.catch((err) => {
				this.log.debug('Failed to send MCP cancellation notification', {
					'exception.message': toErrorMessage(err),
				})
			})
			.finally(() => {
				clearTimeout(timer)
				this.cancellationControllers.delete(controller)
			})
	}

	private abortCancellations(reason: unknown): void {
		for (const controller of this.cancellationControllers) controller.abort(reason)
		this.cancellationControllers.clear()
	}

	/**
	 * Fail every in-flight request with the same reason.
	 *
	 * Previously only `disconnect()` did this, so a transport that dropped
	 * on its own — process exit, socket reset, server crash — left callers
	 * waiting on promises that could never settle.
	 */
	private rejectAllPending(reason: string): void {
		if (this.pendingRequests.size === 0) return
		this.log.warn('Failing in-flight MCP requests', {
			'namzu.connector.server': this.config.serverName,
			'namzu.connector.count': this.pendingRequests.size,
			'namzu.connector.reason': reason,
		})
		for (const pending of [...this.pendingRequests.values()]) {
			pending.abort(new Error(reason))
		}
	}

	private async notify(method: string, params: Record<string, unknown>): Promise<void> {
		const envelope = buildEnvelope({
			era: this.era,
			method,
			params,
			clientInfo: this.config.clientInfo ?? NAMZU_CLIENT_INFO,
			capabilities: this.config.capabilities ?? {},
		})
		const message: MCPJsonRpcMessage = {
			jsonrpc: '2.0',
			method,
			params: envelope.params,
		}
		await this.transport.send(message, this.eraHeaderOptions(envelope.headers))
	}

	private handleMessage(message: MCPJsonRpcMessage): void {
		if (message.id !== undefined) {
			const pending = this.pendingRequests.get(message.id)
			if (pending) {
				if (message.error) {
					pending.reject(protocolErrorFromReply(message.error))
				} else {
					pending.resolve(message.result)
				}
				return
			}
		}

		if (message.method && message.id === undefined) {
			for (const handler of this.notificationHandlers) {
				handler(message.method, message.params)
			}
			return
		}

		// A frame carrying BOTH an id and a method is a server-initiated
		// REQUEST — `sampling/createMessage`, `elicitation/create`,
		// `roots/list`, `ping`. It matched neither branch above and was
		// dropped on the floor, so a spec-current server sat waiting for a
		// reply that would never come, which looks exactly like a hang.
		// Answer honestly: we do not implement these yet.
		if (message.method && message.id !== undefined) {
			this.log.warn('Declining unsupported server-initiated MCP request', {
				'namzu.connector.server': this.config.serverName,
				'namzu.connector.method': message.method,
			})
			void this.transport
				.send({
					jsonrpc: '2.0',
					id: message.id,
					error: {
						code: JSON_RPC_METHOD_NOT_FOUND,
						message: `Method not found: ${message.method}`,
					},
				})
				.catch((err) => {
					this.log.debug('Failed to send method-not-found reply', {
						'exception.message': toErrorMessage(err),
					})
				})
		}
	}

	private requireConnected(): void {
		if (this.status !== 'connected') {
			throw new Error(
				`MCPClient "${this.config.serverName}" is not connected (status: ${this.status})`,
			)
		}
	}
}
