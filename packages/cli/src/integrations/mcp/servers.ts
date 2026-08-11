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
 * Its tools arrive prefixed with the server's name (`mcp_tickets_create`), so
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
	MCPClient,
	type MCPTransportUnion,
	type ToolDefinition,
	mcpToolToToolDefinition,
} from '@namzu/sdk'

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
	readonly headers?: Readonly<Record<string, string>>
}

export type McpServersConfig = Readonly<Record<string, McpServerSpec>>

export interface ConnectedMcpServer {
	readonly name: string
	readonly toolCount: number
}

export interface FailedMcpServer {
	readonly name: string
	/** Phrased for one line in front of a person who has to fix it. */
	readonly reason: string
}

export interface McpConnection {
	/** Adapted tools from every server that connected, ready to register. */
	readonly tools: readonly ToolDefinition[]
	readonly connected: readonly ConnectedMcpServer[]
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
 * Turn one spec into a transport, or say why it is not one.
 *
 * Refused rather than guessed. A spec with both a command and a URL is an
 * operator who edited one into a file that already had the other, and picking
 * either would run something they did not mean to run.
 */
export function transportFor(spec: McpServerSpec, defaultCwd: string): MCPTransportUnion | string {
	const hasCommand = typeof spec.command === 'string' && spec.command.trim().length > 0
	const hasUrl = typeof spec.url === 'string' && spec.url.trim().length > 0
	if (hasCommand && hasUrl) {
		return 'it declares both a command and a url — pick one'
	}
	if (hasCommand) {
		return {
			type: 'stdio',
			command: spec.command as string,
			...(spec.args ? { args: [...spec.args] } : {}),
			...(spec.env ? { env: { ...spec.env } } : {}),
			...(spec.inheritEnv ? { inheritEnv: [...spec.inheritEnv] } : {}),
			cwd: spec.cwd ?? defaultCwd,
		}
	}
	if (hasUrl) {
		return {
			type: 'streamable-http',
			url: spec.url as string,
			...(spec.headers ? { headers: { ...spec.headers } } : {}),
		}
	}
	return 'it declares neither a command nor a url'
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

export async function connectMcpServers(
	config: McpServersConfig | undefined,
	options: { readonly cwd: string },
): Promise<McpConnection> {
	const entries = Object.entries(config ?? {})
	const tools: ToolDefinition[] = []
	const connected: ConnectedMcpServer[] = []
	const failed: FailedMcpServer[] = []
	const clients: MCPClient[] = []

	// Sequential, not parallel. Each server may spawn a process and each is
	// bounded separately; a parallel fan-out would make the worst case the sum
	// of nothing and the failure output arrive interleaved, for a saving that
	// matters only to someone running many servers, who has other problems.
	for (const [name, spec] of entries) {
		const transport = transportFor(spec, options.cwd)
		if (typeof transport === 'string') {
			failed.push({ name, reason: transport })
			continue
		}
		const client = new MCPClient({ serverName: name, transport })
		try {
			await withDeadline(client.connect(), CONNECT_TIMEOUT_MS, `server "${name}"`)
			const listed = await withDeadline(
				client.listTools(),
				CONNECT_TIMEOUT_MS,
				`server "${name}" listing its tools`,
			)
			for (const tool of listed) {
				tools.push(mcpToolToToolDefinition(tool, client, name))
			}
			connected.push({ name, toolCount: listed.length })
			clients.push(client)
		} catch (err) {
			failed.push({ name, reason: reasonOf(err) })
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

	return {
		tools,
		connected,
		failed,
		close: async () => {
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
