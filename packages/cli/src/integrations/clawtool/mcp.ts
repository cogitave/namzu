/**
 * Minimal MCP-over-Streamable-HTTP client for clawtool's `/mcp` endpoint.
 *
 * We deliberately do not reuse `@namzu/sdk`'s `MCPClient` http-sse
 * transport — that implementation targets the older MCP HTTP+SSE
 * transport (separate /sse + /message channels), whereas clawtool uses
 * the newer **Streamable HTTP** transport (single POST that may return
 * a chunked SSE response with one or more `data:` events). Wire details
 * verified against clawtool/internal/server/{http.go,mcp_headers.go}.
 *
 * Scope: `initialize` → `notifications/initialized` handshake, then
 * `tools/list` and `tools/call`. Streaming multi-event responses are
 * read fully before resolving (clawtool's current handlers return a
 * single event per call).
 */

import type { McpCallResult, McpToolDescriptor } from './types.js'

export const MCP_PROTOCOL_VERSION = '2024-11-05'

export class McpProtocolError extends Error {
	constructor(
		message: string,
		readonly code?: number,
	) {
		super(message)
		this.name = 'McpProtocolError'
	}
}

export interface McpClientOptions {
	readonly endpoint: string
	readonly token: string
	readonly clientInfo?: { name: string; version: string }
	/** Override `fetch` for tests. */
	readonly fetch?: typeof fetch
	/** Per-request timeout in ms. Default 30s. */
	readonly timeoutMs?: number
}

interface JsonRpcRequest {
	jsonrpc: '2.0'
	id: number
	method: string
	params?: Record<string, unknown>
}

interface JsonRpcResponse<T> {
	jsonrpc: '2.0'
	id: number
	result?: T
	error?: { code: number; message: string; data?: unknown }
}

interface ListToolsResult {
	tools: McpToolDescriptor[]
}

export class ClawtoolMcpClient {
	private id = 0
	private initialized = false
	private sessionId: string | null = null
	private readonly fetchFn: typeof fetch
	private readonly timeoutMs: number

	constructor(private readonly opts: McpClientOptions) {
		this.fetchFn = opts.fetch ?? globalThis.fetch
		this.timeoutMs = opts.timeoutMs ?? 30_000
	}

	async initialize(): Promise<void> {
		if (this.initialized) return
		await this.rpc('initialize', {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: this.opts.clientInfo ?? { name: 'namzu', version: '0.0.0' },
		})
		// `notifications/initialized` is a notification — JSON-RPC with no
		// `id`, no response expected. Fire and forget over the same endpoint.
		await this.notify('notifications/initialized', {})
		this.initialized = true
	}

	async listTools(): Promise<McpToolDescriptor[]> {
		await this.initialize()
		const result = await this.rpc<ListToolsResult>('tools/list', {})
		return result.tools
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
		await this.initialize()
		return this.rpc<McpCallResult>('tools/call', { name, arguments: args })
	}

	private async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
		const id = ++this.id
		const body: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
		const url = `${this.opts.endpoint.replace(/\/$/, '')}/mcp`
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), this.timeoutMs)
		let response: Response
		try {
			response = await this.fetchFn(url, {
				method: 'POST',
				headers: this.headers(method, params),
				body: JSON.stringify(body),
				signal: controller.signal,
			})
		} finally {
			clearTimeout(timer)
		}
		this.captureSessionId(response)
		if (!response.ok) {
			throw new McpProtocolError(
				`clawtool MCP request to ${method} failed: HTTP ${response.status}`,
				response.status,
			)
		}
		const envelope = await this.readEnvelope<T>(response)
		if (envelope.error) {
			throw new McpProtocolError(
				`clawtool MCP method ${method} returned error: ${envelope.error.message}`,
				envelope.error.code,
			)
		}
		if (envelope.result === undefined) {
			throw new McpProtocolError(`clawtool MCP method ${method} returned no result`)
		}
		return envelope.result
	}

	private async notify(method: string, params: Record<string, unknown>): Promise<void> {
		const body = { jsonrpc: '2.0' as const, method, params }
		const url = `${this.opts.endpoint.replace(/\/$/, '')}/mcp`
		const response = await this.fetchFn(url, {
			method: 'POST',
			headers: this.headers(method, params),
			body: JSON.stringify(body),
		})
		this.captureSessionId(response)
	}

	private captureSessionId(response: Response): void {
		// MCP Streamable HTTP issues a session ID on `initialize` and expects
		// it echoed on every subsequent request. clawtool returns it via the
		// `Mcp-Session-Id` header (see internal/server/http.go + mark3labs/mcp-go).
		const sid = response.headers.get('mcp-session-id') ?? response.headers.get('Mcp-Session-Id')
		if (sid && sid.length > 0) {
			this.sessionId = sid
		}
	}

	private headers(method: string, params: Record<string, unknown>): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			'Mcp-Method': method,
		}
		// Empty token = `--no-auth` daemon; omit Authorization entirely.
		if (this.opts.token.length > 0) {
			headers.Authorization = `Bearer ${this.opts.token}`
		}
		if (this.sessionId) {
			headers['Mcp-Session-Id'] = this.sessionId
		}
		const name = typeof params.name === 'string' ? params.name : undefined
		if (name && (method === 'tools/call' || method === 'prompts/get')) {
			headers['Mcp-Name'] = name
		}
		return headers
	}

	private async readEnvelope<T>(response: Response): Promise<JsonRpcResponse<T>> {
		const ct = response.headers.get('content-type') ?? ''
		const text = await response.text()
		if (ct.includes('text/event-stream')) {
			return parseSseSingleEvent<T>(text)
		}
		return JSON.parse(text) as JsonRpcResponse<T>
	}
}

function parseSseSingleEvent<T>(raw: string): JsonRpcResponse<T> {
	// Streamable HTTP responses look like:
	//   data: {"jsonrpc":"2.0", ...}
	//   (blank line terminator)
	// We accept multiple events but only return the last well-formed JSON
	// envelope — clawtool's current handlers emit exactly one.
	const lines = raw.split('\n')
	let last: string | undefined
	for (const line of lines) {
		const trimmed = line.replace(/\r$/, '')
		if (trimmed.startsWith('data:')) {
			last = trimmed.slice('data:'.length).trim()
		}
	}
	if (!last) {
		throw new McpProtocolError('clawtool MCP SSE response had no data event')
	}
	return JSON.parse(last) as JsonRpcResponse<T>
}
