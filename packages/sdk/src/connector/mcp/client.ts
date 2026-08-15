import type {
	MCPClientConfig,
	MCPClientState,
	MCPConnectionStatus,
	MCPContentBlock,
	MCPEventListener,
	MCPInitializeResult,
	MCPJsonRpcMessage,
	MCPLifecycleEvent,
	MCPPromptDefinition,
	MCPPromptMessage,
	MCPResource,
	MCPResourceTemplate,
	MCPServerCapabilities,
	MCPToolDefinition,
	MCPToolResult,
	MCPTransport,
	MCPTransportUnion,
} from '../../types/connector/index.js'
import type { MCPClientId } from '../../types/ids/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { generateMCPClientId } from '../../utils/id.js'
import type { LogAttributes } from '../../utils/log/index.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
import { HttpSseTransport } from './http-sse.js'
import { StdioTransport } from './stdio.js'
import { StreamableHttpTransport } from './streamable-http.js'

import {
	DEFAULT_MCP_REQUEST_TIMEOUT_MS,
	JSON_RPC_METHOD_NOT_FOUND,
	MCP_PROTOCOL_VERSION,
	MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from '../../constants/mcp/index.js'
import { NAMZU } from '../../constants/telemetry/index.js'
import { VERSION } from '../../version.js'

/** Runaway guard for a server whose cursor never ends. */
const MAX_LIST_PAGES = 100

const NAMZU_CLIENT_INFO = { name: 'namzu-sdk', version: VERSION }

export class MCPClient {
	readonly id: MCPClientId
	private transport: MCPTransport
	private status: MCPConnectionStatus = 'disconnected'
	private serverInfo?: { name: string; version?: string }
	private serverCapabilities?: MCPServerCapabilities
	private connectedAt?: number
	private error?: string
	private pendingRequests = new Map<
		string | number,
		{
			resolve: (value: unknown) => void
			reject: (reason: Error) => void
		}
	>()
	private nextRequestId = 1
	private notificationHandlers: Array<(method: string, params?: Record<string, unknown>) => void> =
		[]
	private lifecycleListeners: MCPEventListener[] = []
	private log: Logger
	private readonly config: MCPClientConfig

	constructor(config: MCPClientConfig) {
		this.config = config
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

		try {
			this.transport.onMessage((msg) => this.handleMessage(msg))
			this.transport.onClose(() => {
				this.status = 'disconnected'
				this.log.info('MCP transport closed')
				this.emitLifecycle({ type: 'mcp_client_disconnected', clientId: this.id })
				this.rejectAllPending(`MCP transport to "${this.config.serverName}" closed`)
			})
			this.transport.onError((err) => {
				this.status = 'error'
				this.error = err.message
				this.log.error('MCP transport error', { error: err.message })
				this.emitLifecycle({ type: 'mcp_client_error', clientId: this.id, error: err.message })
				this.rejectAllPending(`MCP transport to "${this.config.serverName}" failed: ${err.message}`)
			})

			await this.transport.connect()

			const result = (await this.request('initialize', {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: this.config.capabilities ?? {},
				clientInfo: this.config.clientInfo ?? NAMZU_CLIENT_INFO,
			})) as MCPInitializeResult

			// The server answers with the version IT will speak, which need
			// not be the one we asked for. Ignoring that answer — as this did
			// — makes an unspeakable version look like a healthy connection
			// until something downstream breaks in a confusing way.
			const negotiated = result.protocolVersion
			if (negotiated && !MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(negotiated)) {
				throw new Error(
					`MCP server "${this.config.serverName}" negotiated protocol version "${negotiated}", ` +
						`which this client cannot speak (supported: ${MCP_SUPPORTED_PROTOCOL_VERSIONS.join(', ')}).`,
				)
			}
			if (negotiated && negotiated !== MCP_PROTOCOL_VERSION) {
				this.log.info('MCP server negotiated a different protocol version', {
					requested: MCP_PROTOCOL_VERSION,
					negotiated,
				})
			}

			this.serverInfo = result.serverInfo
			this.serverCapabilities = result.capabilities

			await this.notify('notifications/initialized', {})

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
			this.status = 'error'
			this.error = toErrorMessage(err)
			this.log.error('MCP connection failed', { error: this.error })
			this.emitLifecycle({ type: 'mcp_client_error', clientId: this.id, error: this.error })
			throw err
		}
	}

	async disconnect(): Promise<void> {
		if (this.status === 'disconnected') return

		this.rejectAllPending('MCPClient disconnecting')

		await this.transport.close()
		this.status = 'disconnected'
		this.connectedAt = undefined
		this.log.info('MCP client disconnected')
		this.emitLifecycle({ type: 'mcp_client_disconnected', clientId: this.id })
	}

	isConnected(): boolean {
		return this.status === 'connected'
	}

	getState(): MCPClientState {
		return {
			id: this.id,
			serverName: this.config.serverName,
			status: this.status,
			serverInfo: this.serverInfo,
			serverCapabilities: this.serverCapabilities,
			connectedAt: this.connectedAt,
			error: this.error,
		}
	}

	async listTools(): Promise<MCPToolDefinition[]> {
		this.requireConnected()
		return await this.listAllPages('tools/list', 'tools')
	}

	async callTool(name: string, args?: Record<string, unknown>): Promise<MCPToolResult> {
		this.requireConnected()
		const result = (await this.request('tools/call', {
			name,
			arguments: args ?? {},
		})) as MCPToolResult
		return result
	}

	async listResources(): Promise<MCPResource[]> {
		this.requireConnected()
		return await this.listAllPages('resources/list', 'resources')
	}

	async readResource(uri: string): Promise<MCPContentBlock[]> {
		this.requireConnected()
		const result = (await this.request('resources/read', { uri })) as {
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
	async listPrompts(): Promise<MCPPromptDefinition[]> {
		this.requireConnected()
		return await this.listAllPages('prompts/list', 'prompts')
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
	): Promise<{ description?: string; messages: MCPPromptMessage[] }> {
		this.requireConnected()
		const result = (await this.request('prompts/get', {
			name,
			arguments: args ?? {},
		})) as { description?: string; messages?: MCPPromptMessage[] }
		return {
			...(result.description !== undefined ? { description: result.description } : {}),
			messages: result.messages ?? [],
		}
	}

	async listResourceTemplates(): Promise<MCPResourceTemplate[]> {
		this.requireConnected()
		return await this.listAllPages('resources/templates/list', 'resourceTemplates')
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
	private async listAllPages<T>(method: string, field: string): Promise<T[]> {
		const items: T[] = []
		let cursor: string | undefined

		for (let page = 1; ; page++) {
			const result = (await this.request(method, cursor === undefined ? {} : { cursor })) as Record<
				string,
				unknown
			>

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
				this.log.warn('MCP lifecycle listener threw', { error: toErrorMessage(err) })
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
	 * server hung the whole run with no error and no `run_failed`: not a
	 * crash, just a process that stopped.
	 */
	private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = this.nextRequestId++
		const message: MCPJsonRpcMessage = {
			jsonrpc: '2.0',
			id,
			method,
			params,
		}
		const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS

		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id)
				this.log.warn('MCP request timed out', {
					server: this.config.serverName,
					method,
					timeoutMs,
				})
				reject(
					new Error(
						`MCP request "${method}" to "${this.config.serverName}" timed out after ${timeoutMs}ms`,
					),
				)
			}, timeoutMs)

			this.pendingRequests.set(id, {
				resolve: (value) => {
					clearTimeout(timer)
					resolve(value)
				},
				reject: (err) => {
					clearTimeout(timer)
					reject(err)
				},
			})

			this.transport.send(message).catch((err) => {
				clearTimeout(timer)
				this.pendingRequests.delete(id)
				reject(err)
			})
		})
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
			server: this.config.serverName,
			count: this.pendingRequests.size,
			reason,
		})
		for (const [, pending] of this.pendingRequests) {
			pending.reject(new Error(reason))
		}
		this.pendingRequests.clear()
	}

	private async notify(method: string, params: Record<string, unknown>): Promise<void> {
		const message: MCPJsonRpcMessage = {
			jsonrpc: '2.0',
			method,
			params,
		}
		await this.transport.send(message)
	}

	private handleMessage(message: MCPJsonRpcMessage): void {
		if (message.id !== undefined) {
			const pending = this.pendingRequests.get(message.id)
			if (pending) {
				this.pendingRequests.delete(message.id)
				if (message.error) {
					pending.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`))
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
				server: this.config.serverName,
				method: message.method,
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
						error: toErrorMessage(err),
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
