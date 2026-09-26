/**
 * External tool servers an operator declares in their config.
 *
 * The kernel has spoken this protocol for a long time — `MCPClient`,
 * `StdioTransport`, `StreamableHttpTransport` and the tool adapter are all
 * exported from `@namzu/sdk`. `packages/cli` imported none of them, so the
 * capability existed and was unreachable from the product: a namzu user could
 * not connect an external tool server at all, whatever the kernel could do.
 *
 * A server is declared by name under `mcpServers` in `namzu.config.json`:
 *
 *     "mcpServers": {
 *       "tickets": { "command": "node", "args": ["./tickets-server.js"] },
 *       "search":   { "url": "https://tools.example.internal/mcp" }
 *     }
 *
 * Its tools arrive prefixed with the server's name (`mcp__tickets__create`), so
 * two servers offering `search` do not collide and the transcript says where a
 * call went.
 *
 * ## Every failure is named
 *
 * A server that does not start, a spec that names neither a command nor a URL,
 * a handshake that never answers — each becomes an entry in `failed` with a
 * reason, never an absence. The whole hazard of this feature is the operator
 * who configures a server, watches the agent run without its tools, and
 * concludes the model is bad at the task.
 *
 * What to DO about a failure is not decided here, because the answer differs
 * by surface: a person watching the TUI can read the line and fix their config,
 * and a headless run has nobody to read anything, so it refuses. This module
 * reports; the callers decide.
 */

import {
	UnauthorizedError,
	auth,
	extractWWWAuthenticateParams,
	withOAuth,
} from '@modelcontextprotocol/client'

import {
	MCPClient,
	type MCPFetchLike,
	MCPHttpStatusError,
	type MCPToolDrift,
	type MCPToolsetOptions,
	type MCPTransportUnion,
	type ToolDefinition,
	type Toolset,
	mcpToolset,
	requireApproval,
} from '@namzu/sdk'

import {
	McpOAuthLoginRequiredError,
	McpOAuthStoreError,
	createMcpOAuthProvider,
	hasMcpOAuthTokens,
	isSecureMcpOAuthUrl,
	mcpOAuthPath,
} from './oauth-store.js'

/**
 * How long a single server gets to connect, hand shake and list its tools.
 *
 * The client's own `requestTimeoutMs` bounds one round trip; it cannot bound a
 * process that spawns and never speaks. Without this, one wedged server holds
 * the whole session open before the first turn — no error, no failure, just a
 * namzu that does not start.
 */
export const CONNECT_TIMEOUT_MS = 10_000

/**
 * How long shutting one server down may take before it is given up on.
 *
 * Shorter than the connect bound because nothing waits on the answer: a
 * one-shot is exiting and a TUI is replacing the session. What this prevents
 * is the opposite of a leak — a `close()` that never resolves, holding the
 * command open past the work it was asked to do.
 */
export const CLOSE_TIMEOUT_MS = 2_000

/** A single entry under `mcpServers`. Either a command or a URL, never both. */
export interface McpServerSpec {
	/** Stdio: the executable to run. */
	readonly command?: string
	readonly args?: readonly string[]
	/**
	 * A value may reference the operator's own environment with a bare
	 * `${VAR_NAME}` — no `${VAR:-default}` fallback, and an unset
	 * `VAR_NAME` fails this server with a named reason rather than running
	 * with an empty string. See {@link expandEnvRefsInRecord}. Prefer
	 * `inheritEnv` below for a plain "grant this variable under its own
	 * name"; use `${VAR_NAME}` here to rename a variable into whatever key
	 * the server expects.
	 */
	readonly env?: Readonly<Record<string, string>>
	/**
	 * Variables from the operator's own environment this server may have.
	 *
	 * The child used to receive the whole parent environment, so every server
	 * held every credential on the machine. It now gets process plumbing plus
	 * what is named — so a server that needs one token is granted that token,
	 * and the config is where a reviewer can see it.
	 *
	 * Prefer this over `env` for anything secret: `env` writes the value into
	 * the config file, and this leaves it in the environment.
	 */
	readonly inheritEnv?: readonly string[]
	/** Working directory for the child. Defaults to the agent's. */
	readonly cwd?: string
	/** HTTP: the server's endpoint. */
	readonly url?: string
	/**
	 * Same `${VAR_NAME}` expansion as `env` above — the only secret-safe
	 * option for a header value, since `inheritEnv` reaches the stdio
	 * child's process environment only, never an HTTP header.
	 */
	readonly headers?: Readonly<Record<string, string>>
	/**
	 * How long THIS server gets to connect, hand shake and list its tools, in
	 * milliseconds. Default {@link CONNECT_TIMEOUT_MS}.
	 *
	 * The default is sized for a wedged server, not a slow one. A server whose
	 * first spawn is genuinely slow — a Python SDK server cold-boots in 15-20s
	 * on some machines — is a working server the default refuses, and a
	 * headless run that needs it stops before its first turn. Raise this for
	 * that server alone; the others keep the bound that protects the session.
	 */
	readonly connectTimeoutMs?: number
	/**
	 * How long THIS server's era probe — `connect()`'s `server/discover`
	 * check for a modern peer, sent before the legacy handshake — waits for
	 * an answer, in milliseconds. Defaults to the SDK's own
	 * `MCPClientConfig.eraProbeTimeoutMs` (`2000`, clamped to whichever
	 * `connectTimeoutMs` this server ends up with).
	 *
	 * The probe costs nothing against a server that answers — modern or
	 * legacy — because either answer settles it immediately. It costs THIS
	 * long against a legacy server old enough to stay silent on a method it
	 * has never heard of, once per origin or per resolved command, not once
	 * per turn. Lower it for a stdio server known to be that old and slow to
	 * connect, so the probe gives up sooner and leaves more of
	 * `connectTimeoutMs` for the handshake that will actually answer.
	 */
	readonly eraProbeTimeoutMs?: number
	/** Server-reported names admitted from tools, prompts and resources. */
	readonly allow?: readonly string[]
	/** Server-reported names refused even if `allow` includes them. */
	readonly deny?: readonly string[]
	/** Retries only tool calls the SDK marks safe to repeat. Defaults to none. */
	readonly maxRetries?: number
	/** Require a person to approve every call this server contributes. */
	readonly requireApproval?: boolean
	/** Trust this server's read-only hints for review exemptions. Defaults to false. */
	readonly readOnlyHintTrusted?: boolean
	/** Include the server's own initialize instructions as untrusted turn context. Default false. */
	readonly instructions?: boolean
}

export type McpServersConfig = Readonly<Record<string, McpServerSpec>>

export interface ConnectedMcpServer {
	readonly name: string
	readonly toolCount: number
	/**
	 * What this server actually contributes, by tool name.
	 *
	 * Carried from the listing rather than recovered later. The names arrive
	 * prefixed with the server's own (`mcp__tickets__create`), so a caller COULD
	 * split them back apart — but that turns an encoding this file owns into a
	 * format two places have to agree about, and the list is free right here.
	 */
	readonly tools: readonly string[]
	/** The server's current initialize instructions, if it supplied any. */
	readonly instructions?: string
	/** Names changed since this connection's first listing; changed definitions remain held. */
	readonly drift?: MCPToolDrift
	/** Current allow/deny refusals, by server-reported name. */
	readonly refused?: readonly {
		kind: 'tools' | 'prompts' | 'resources'
		name: string
		reason: 'not_allowed' | 'denied'
	}[]
}

export interface FailedMcpServer {
	readonly name: string
	/** Phrased for one line in front of a person who has to fix it. */
	readonly reason: string
}

export interface McpConnection {
	/** Current definitions from every connected server, read from its live toolsets. */
	readonly tools: readonly ToolDefinition[]
	/**
	 * Two live entries per connected server: its configured main tools and its
	 * always-deferred resource tools. Both carry the `mcp:<server>` source.
	 */
	readonly toolsets: readonly Toolset[]
	/** One coherent live snapshot; use this when successes and failures are shown together. */
	current(): {
		readonly connected: readonly ConnectedMcpServer[]
		readonly failed: readonly FailedMcpServer[]
	}
	/** Servers whose transports are connected right now. Read live. */
	readonly connected: readonly ConnectedMcpServer[]
	/** Startup failures plus transports that failed or closed later. Read live. */
	readonly failed: readonly FailedMcpServer[]
	/**
	 * Shut every connected server down.
	 *
	 * A stdio server is a CHILD PROCESS. Nothing else in this package owns one,
	 * which is why the session had no shutdown path before: without this, a TUI
	 * session that ends leaves the child running, and a long-lived host that
	 * opens sessions leaks one per session.
	 */
	close(): Promise<void>
}

/**
 * A bare `${VAR}` reference inside an `env` or `headers` value — identifier
 * characters only, no `:-default` fallback. See {@link expandEnvRefsInRecord}.
 */
const ENV_REF_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * Expand `${VAR}` references inside `env`/`headers` values against the
 * operator's own environment.
 *
 * Deliberately narrower than the interpolation some other MCP clients'
 * configs use (see docs/cli/mcp-servers.md): bare `${VAR}` only, no
 * `${VAR:-default}` fallback, and only inside `env` and `headers` values —
 * never `command`, `args`, `url` or `cwd`, which have no legitimate secret
 * use case and would only widen the surface for an accidental literal `${`
 * to break. A referenced variable that is unset is refused with a named
 * reason, not silently substituted with an empty string: that is exactly
 * the footgun a `:-default` fallback would reintroduce, and this module's
 * whole design is "every failure is named" rather than a server running
 * quietly with a secret it never got.
 *
 * `inheritEnv` stays the primary idiom for "grant this named variable to
 * the child process under its own name" — this is for the config VALUE
 * itself, letting an operator rename an env var into whatever key or
 * header a server expects, and giving `headers` a secret-safe option it
 * has never had (`inheritEnv` only reaches the stdio child's process env,
 * not header values).
 *
 * Returns the expanded record, or a reason string naming the first unset
 * variable a value referenced.
 */
export function expandEnvRefsInRecord(
	record: Readonly<Record<string, string>>,
	env: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> | string {
	const result: Record<string, string> = {}
	for (const [key, raw] of Object.entries(record)) {
		let missing: string | undefined
		const expanded = raw.replace(ENV_REF_PATTERN, (whole, name: string) => {
			const value = env[name]
			if (value === undefined) {
				missing = name
				return whole
			}
			return value
		})
		if (missing !== undefined) {
			return `references \${${missing}}, which is not set in the operator's environment`
		}
		result[key] = expanded
	}
	return result
}

/**
 * Turn one spec into a transport, or say why it is not one.
 *
 * Refused rather than guessed. A spec with both a command and a URL is an
 * operator who edited one into a file that already had the other, and picking
 * either would run something they did not mean to run.
 */
export function transportFor(
	spec: McpServerSpec,
	defaultCwd: string,
	env: NodeJS.ProcessEnv = process.env,
): MCPTransportUnion | string {
	const hasCommand = typeof spec.command === 'string' && spec.command.trim().length > 0
	const hasUrl = typeof spec.url === 'string' && spec.url.trim().length > 0
	if (hasCommand && hasUrl) {
		return 'it declares both a command and a url — pick one'
	}
	if (hasCommand) {
		const expandedEnv = spec.env ? expandEnvRefsInRecord(spec.env, env) : undefined
		if (typeof expandedEnv === 'string') return expandedEnv
		return {
			type: 'stdio',
			command: spec.command as string,
			...(spec.args ? { args: [...spec.args] } : {}),
			...(expandedEnv ? { env: expandedEnv } : {}),
			...(spec.inheritEnv ? { inheritEnv: [...spec.inheritEnv] } : {}),
			cwd: spec.cwd ?? defaultCwd,
		}
	}
	if (hasUrl) {
		const expandedHeaders = spec.headers ? expandEnvRefsInRecord(spec.headers, env) : undefined
		if (typeof expandedHeaders === 'string') return expandedHeaders
		return {
			type: 'streamable-http',
			url: spec.url as string,
			...(expandedHeaders ? { headers: expandedHeaders } : {}),
		}
	}
	return 'it declares neither a command nor a url'
}

/** One refresh per credential file; unrelated MCP requests remain concurrent. */
const mcpOAuthRefreshes = new Map<string, Promise<void>>()

function mcpOAuthUnauthorized(): MCPHttpStatusError {
	return new MCPHttpStatusError(
		'MCP OAuth',
		401,
		'authorization required; run `namzu mcp login <server>`',
		'',
	)
}

/**
 * A running agent may reuse a saved OAuth grant, including its refresh token,
 * but only an explicit `mcp login` may begin browser authorization. The store
 * binds the grant to this complete URL (path and query included), and the
 * fetch guard keeps it there even if a transport changes its request target.
 */
function withSavedMcpOAuth(
	transport: Extract<MCPTransportUnion, { url: string }>,
): MCPTransportUnion {
	if (transport.type !== 'streamable-http') return transport
	// A configured Authorization header is the operator's chosen credential.
	// The official middleware would replace it with the saved bearer token.
	if (Object.keys(transport.headers ?? {}).some((key) => key.toLowerCase() === 'authorization')) {
		return transport
	}
	let endpoint: URL
	try {
		endpoint = new URL(transport.url)
	} catch {
		return transport
	}
	// The OAuth store accepts HTTPS and loopback HTTP. Preserve ordinary MCP
	// behavior for other URLs instead of turning their lack of OAuth into an
	// unrelated startup error.
	if (!isSecureMcpOAuthUrl(endpoint)) return transport
	if (!hasMcpOAuthTokens(transport.url)) return transport

	const provider = createMcpOAuthProvider({ endpoint: transport.url })
	const rawFetch = fetch
	const oauthNetworkFetch = (input: string | URL, init?: RequestInit): Promise<Response> => {
		const target = new URL(String(input))
		if (!isSecureMcpOAuthUrl(target)) {
			throw new McpOAuthStoreError('MCP OAuth network requests require HTTPS or loopback HTTP.')
		}
		// OAuth discovery and token requests may carry a client secret or refresh
		// token. A 307/308 must never replay their POST body to a redirect target.
		return rawFetch(input, { ...init, redirect: 'manual' })
	}
	const credentialKey = mcpOAuthPath(transport.url)
	const authenticatedFetch = withOAuth(
		provider,
		transport.url,
	)(async (input, init) => {
		if (input.toString() !== transport.url) {
			throw new Error('MCP OAuth refused a request to a different endpoint')
		}
		// The bearer token is attached by `withOAuth` before this call. Never
		// auto-follow a redirect with it, including to another path on the
		// same origin, even if an SDK transport changes its own redirect mode.
		const response = await rawFetch(input, { ...init, redirect: 'manual' })
		if (response.status !== 401) return response
		// Intercept the challenge before `withOAuth` can start an independent
		// refresh for every simultaneous request. Its token attachment remains
		// authoritative; the official `auth()` performs the refresh once.
		const attemptedAuthorization = new Headers(init?.headers).get('authorization')
		const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response)
		void response.body?.cancel().catch(() => undefined)
		let refresh = mcpOAuthRefreshes.get(credentialKey)
		if (!refresh) {
			refresh = (async () => {
				const current = await provider.tokens()
				if (!current) throw new McpOAuthLoginRequiredError()
				// Another connection or process may have renewed this grant while
				// the old request was in flight. Its new access token is enough.
				if (attemptedAuthorization !== `Bearer ${current.access_token}`) return
				const result = await auth(provider, {
					serverUrl: transport.url,
					resourceMetadataUrl,
					scope,
					fetchFn: oauthNetworkFetch,
				})
				if (result !== 'AUTHORIZED') throw new McpOAuthLoginRequiredError()
			})()
			mcpOAuthRefreshes.set(credentialKey, refresh)
			const ownedRefresh = refresh
			void ownedRefresh.then(
				() => {
					if (mcpOAuthRefreshes.get(credentialKey) === ownedRefresh) {
						mcpOAuthRefreshes.delete(credentialKey)
					}
				},
				() => {
					if (mcpOAuthRefreshes.get(credentialKey) === ownedRefresh) {
						mcpOAuthRefreshes.delete(credentialKey)
					}
				},
			)
		}
		try {
			await refresh
		} catch {
			// A second process may have won a rotating-token refresh while
			// this one failed. The store's issuer/endpoint binding still holds;
			// one retry with its new token is safe and avoids a false failure.
			const latest = await provider.tokens()
			if (!latest || attemptedAuthorization === `Bearer ${latest.access_token}`) {
				throw mcpOAuthUnauthorized()
			}
		}
		const current = await provider.tokens()
		if (!current) throw mcpOAuthUnauthorized()
		const headers = new Headers(init?.headers)
		headers.set('Authorization', `Bearer ${current.access_token}`)
		const retried = await rawFetch(input, { ...init, headers, redirect: 'manual' })
		if (retried.status === 401) {
			void retried.body?.cancel().catch(() => undefined)
			throw mcpOAuthUnauthorized()
		}
		return retried
	})
	const oauthFetch: MCPFetchLike = async (input, init) => {
		// `withOAuth` authenticates any URL handed to it. Our Streamable HTTP
		// transport sends the configured URL exactly; reject any other target
		// before the bearer token can reach it.
		if (input !== transport.url) {
			throw new Error('MCP OAuth refused a request to a different endpoint')
		}
		try {
			if (!(await provider.tokens())) throw new McpOAuthLoginRequiredError()
			return await authenticatedFetch(input, init)
		} catch (error) {
			if (
				error instanceof UnauthorizedError ||
				error instanceof McpOAuthLoginRequiredError ||
				error instanceof McpOAuthStoreError
			) {
				// The official middleware throws after a 401 or failed refresh.
				// The SDK's era probe recognizes its own HTTP status error and
				// refuses 401 instead of offering a legacy initialize handshake.
				throw mcpOAuthUnauthorized()
			}
			throw error
		}
	}
	return { ...transport, fetch: oauthFetch }
}

async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms}ms`)), ms)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * The connect deadline a spec asks for, or why it cannot have it.
 *
 * Refused rather than defaulted: a value that is not a positive number is an
 * operator who mistyped the key they were relying on, and silently running
 * with 10s would produce the very failure they were configuring away.
 */
export function connectDeadlineFor(spec: McpServerSpec): number | string {
	const ms = spec.connectTimeoutMs
	if (ms === undefined) return CONNECT_TIMEOUT_MS
	if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
		return `connectTimeoutMs must be a positive number of milliseconds, got ${JSON.stringify(ms)}`
	}
	return ms
}

/**
 * The era probe deadline a spec asks for, or why it cannot have it.
 *
 * `undefined` when the spec names none — unlike {@link connectDeadlineFor},
 * which defaults to a CLI-owned constant, an unset `eraProbeTimeoutMs` is
 * passed through unset so `MCPClient` applies ITS OWN default and clamp
 * (`DEFAULT_MCP_ERA_PROBE_TIMEOUT_MS`, never longer than whatever
 * `connectTimeoutMs` this server ends up with). Refused rather than
 * defaulted when given but invalid, for the same reason
 * `connectDeadlineFor` refuses one: an operator who mistyped this key
 * wanted the probe to give up sooner, and silently running with the SDK's
 * default would produce the very wait they were configuring away.
 */
export function eraProbeTimeoutFor(spec: McpServerSpec): number | undefined | string {
	const ms = spec.eraProbeTimeoutMs
	if (ms === undefined) return undefined
	if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
		return `eraProbeTimeoutMs must be a positive number of milliseconds, got ${JSON.stringify(ms)}`
	}
	return ms
}

function toolsetOptionsFor(spec: McpServerSpec, name: string): MCPToolsetOptions | string {
	for (const field of ['allow', 'deny'] as const) {
		const value = spec[field]
		if (
			value !== undefined &&
			(!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0))
		) {
			return `${field} must be a list of nonempty server-reported names`
		}
	}
	if (
		spec.maxRetries !== undefined &&
		(!Number.isSafeInteger(spec.maxRetries) || spec.maxRetries < 0)
	) {
		return `maxRetries must be a nonnegative integer, got ${JSON.stringify(spec.maxRetries)}`
	}
	if (spec.requireApproval !== undefined && typeof spec.requireApproval !== 'boolean') {
		return 'requireApproval must be true or false'
	}
	if (spec.readOnlyHintTrusted !== undefined && typeof spec.readOnlyHintTrusted !== 'boolean') {
		return 'readOnlyHintTrusted must be true or false'
	}
	if (spec.instructions !== undefined && typeof spec.instructions !== 'boolean') {
		return 'instructions must be true or false'
	}
	return {
		id: `mcp:${name}`,
		allow: spec.allow,
		deny: spec.deny,
		maxRetries: spec.maxRetries,
		readOnlyHintTrusted: spec.readOnlyHintTrusted,
	}
}

export async function connectMcpServers(
	config: McpServersConfig | undefined,
	options: { readonly cwd: string },
): Promise<McpConnection> {
	const entries = Object.entries(config ?? {})
	const toolsets: Toolset[] = []
	const startupFailed: FailedMcpServer[] = []
	const clients: MCPClient[] = []
	const liveServers: Array<{
		readonly client: MCPClient
		readonly name: string
		readonly toolsets: readonly Toolset[]
		readonly discovery: {
			readonly added: Set<string>
			readonly removed: Set<string>
			readonly changed: Set<string>
			readonly refused: Map<
				'tools' | 'prompts' | 'resources',
				readonly { name: string; reason: 'not_allowed' | 'denied' }[]
			>
		}
	}> = []

	// Sequential, not parallel. Each server may spawn a process and each is
	// bounded separately; a parallel fan-out would make the worst case the sum
	// of nothing and the failure output arrive interleaved, for a saving that
	// matters only to someone running many servers, who has other problems.
	for (const [name, spec] of entries) {
		if (typeof spec !== 'object' || spec === null) {
			startupFailed.push({ name, reason: 'server spec must be a mapping' })
			continue
		}
		const transport = transportFor(spec, options.cwd)
		if (typeof transport === 'string') {
			startupFailed.push({ name, reason: transport })
			continue
		}
		const deadline = connectDeadlineFor(spec)
		if (typeof deadline === 'string') {
			startupFailed.push({ name, reason: deadline })
			continue
		}
		const eraProbeTimeoutMs = eraProbeTimeoutFor(spec)
		if (typeof eraProbeTimeoutMs === 'string') {
			startupFailed.push({ name, reason: eraProbeTimeoutMs })
			continue
		}
		const toolsetOptions = toolsetOptionsFor(spec, name)
		if (typeof toolsetOptions === 'string') {
			startupFailed.push({ name, reason: toolsetOptions })
			continue
		}
		let connectedTransport: MCPTransportUnion
		try {
			connectedTransport =
				transport.type === 'streamable-http' ? withSavedMcpOAuth(transport) : transport
		} catch (error) {
			startupFailed.push({ name, reason: reasonOf(error) })
			continue
		}
		const client = new MCPClient({
			serverName: name,
			transport: connectedTransport,
			...(eraProbeTimeoutMs !== undefined ? { eraProbeTimeoutMs } : {}),
		})
		const discovery = {
			added: new Set<string>(),
			removed: new Set<string>(),
			changed: new Set<string>(),
			refused: new Map<
				'tools' | 'prompts' | 'resources',
				readonly { name: string; reason: 'not_allowed' | 'denied' }[]
			>(),
		}
		try {
			await withDeadline(client.connect(), deadline, `server "${name}"`)
			const discovered = await withDeadline(
				mcpToolset(client, {
					...toolsetOptions,
					onDrift: ({ drift }) => {
						for (const item of drift.added) discovery.added.add(item)
						for (const item of drift.removed) discovery.removed.add(item)
						for (const item of drift.changed) discovery.changed.add(item)
					},
					onRefused: ({ kind, refused }) => discovery.refused.set(kind, refused),
				}),
				deadline,
				`server "${name}" discovering its tools`,
			)
			const mounted = spec.requireApproval
				? discovered.map((entry) => requireApproval(entry))
				: [...discovered]
			toolsets.push(...mounted)
			liveServers.push({ client, name, toolsets: mounted, discovery })
			clients.push(client)
		} catch (err) {
			startupFailed.push({ name, reason: reasonOf(err) })
			// A half-connected client still owns a child process. Tearing it down
			// here is the difference between a failed server and a leaked one.
			//
			// Bounded, and deliberately not dependent on what a transport does
			// when it is closed having never connected — the shipped transports
			// disagree about that (one returns early, one notifies), the
			// divergence is a known one, and a shutdown path that only works
			// under one of the two answers is a shutdown path waiting to hang.
			// Nothing here reads the client's state afterwards either.
			try {
				await withDeadline(client.disconnect(), CLOSE_TIMEOUT_MS, `closing "${name}"`)
			} catch {
				// Already gone, never started, or refusing to answer. The failure is
				// already recorded and there is nothing further to do about it.
			}
		}
	}

	const current = (): {
		connected: readonly ConnectedMcpServer[]
		failed: readonly FailedMcpServer[]
	} => {
		const connected: ConnectedMcpServer[] = []
		const failed: FailedMcpServer[] = [...startupFailed]
		for (const { client, name, toolsets: serverToolsets, discovery } of liveServers) {
			const state = client.getState()
			if (state.status === 'connected') {
				const names = serverToolsets.flatMap((entry) => entry.tools().map((tool) => tool.name))
				connected.push({
					name,
					toolCount: names.length,
					tools: names,
					drift: {
						added: [...discovery.added],
						removed: [...discovery.removed],
						changed: [...discovery.changed],
					},
					refused: [...discovery.refused.entries()].flatMap(([kind, items]) =>
						items.map((item) => ({ kind, ...item })),
					),
					...(state.serverInstructions !== undefined
						? { instructions: state.serverInstructions }
						: {}),
				})
				continue
			}
			failed.push({
				name,
				reason:
					state.error ??
					(state.status === 'disconnected'
						? 'connection closed after startup'
						: `connection is ${state.status}`),
			})
		}
		return { connected, failed }
	}

	return {
		get tools() {
			return toolsets.flatMap((entry) => entry.tools())
		},
		toolsets,
		current,
		get connected() {
			return current().connected
		},
		get failed() {
			return current().failed
		},
		close: async () => {
			await Promise.all(toolsets.map((entry) => entry.close?.()))
			await Promise.all(
				clients.map((c) =>
					withDeadline(c.disconnect(), CLOSE_TIMEOUT_MS, 'closing a tool server').catch(() => {
						// Shutting down is best effort by definition: the process may
						// already be gone, and nothing useful follows from saying so.
						// Bounded so a server that will not close cannot hold the
						// command open past the work it was asked to do.
					}),
				),
			)
		},
	}
}
