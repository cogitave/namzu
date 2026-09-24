/**
 * A minimal, in-memory MCP server for exercising `mcpToolset` end to end:
 * real `MCPClient` protocol handling (era negotiation, notifications,
 * requests) against a script that answers exactly what a test says, with no
 * process and no socket.
 *
 * `client.test.ts` and `prompts-and-lifecycle.test.ts` already swap a fake
 * `MCPTransport` onto a constructed `MCPClient` (`createTransport` would
 * otherwise spawn a real process); this generalises that trick into a
 * reusable server that also serves `tools/list`, `tools/call`,
 * `prompts/list`, `prompts/get`, `resources/list` and `resources/read`, and
 * can push `list_changed` notifications and simulate a dropped connection —
 * the shapes `mcpToolset`'s own tests need and no existing fixture serves.
 */

import type {
	MCPJsonRpcMessage,
	MCPPromptDefinition,
	MCPResource,
	MCPServerCapabilities,
	MCPToolDefinition,
	MCPToolResult,
	MCPTransport,
} from '../../../types/connector/index.js'
import { MCPClient } from '../client.js'
import { createMcpEraCache } from '../era.js'

export interface ScriptedMcpServerConfig {
	readonly serverName?: string
	readonly tools?: readonly MCPToolDefinition[]
	readonly prompts?: readonly MCPPromptDefinition[]
	readonly resources?: readonly MCPResource[]
	/**
	 * Defaults to advertising `listChanged: true` for exactly the lists this
	 * config was given at least one entry for (or an explicit empty array —
	 * `capabilities` overrides this entirely when given).
	 */
	readonly capabilities?: MCPServerCapabilities
	readonly instructions?: string
	/**
	 * Per-tool-name RAW `tools/call` result (before the MRTR `resultType`
	 * envelope is peeled off — see `envelope.ts`'s `decodeResult`), for a
	 * test that needs an `input_required` or other non-`complete` shape.
	 * Missing a name echoes a plain success.
	 */
	readonly toolResults?: Readonly<Record<string, unknown>>
}

export interface ScriptedMcpServer {
	readonly client: MCPClient
	/** The calls `tools/call` received, in order. */
	readonly toolCalls: { name: string; args: Record<string, unknown> }[]
	/** The URIs `resources/read` received, in order. */
	readonly resourceReads: string[]
	setTools(tools: readonly MCPToolDefinition[]): void
	setPrompts(prompts: readonly MCPPromptDefinition[]): void
	setResources(resources: readonly MCPResource[]): void
	/** Push `notifications/<kind>/list_changed`, independent of the list itself. */
	fireListChanged(kind: 'tools' | 'prompts' | 'resources'): void
	/** Simulate the transport dying — `client`'s own `onClose` fires. */
	dropConnection(): void
}

/** `capabilities` a fresh config implies, when none was given explicitly. */
function impliedCapabilities(config: ScriptedMcpServerConfig): MCPServerCapabilities {
	return {
		...(config.tools !== undefined ? { tools: { listChanged: true } } : {}),
		...(config.prompts !== undefined ? { prompts: { listChanged: true } } : {}),
		...(config.resources !== undefined ? { resources: { listChanged: true } } : {}),
	}
}

export function scriptedMcpServer(config: ScriptedMcpServerConfig = {}): ScriptedMcpServer {
	const serverName = config.serverName ?? 'srv'
	let tools = [...(config.tools ?? [])]
	let prompts = [...(config.prompts ?? [])]
	let resources = [...(config.resources ?? [])]
	const toolCalls: { name: string; args: Record<string, unknown> }[] = []
	const resourceReads: string[] = []
	const capabilities = config.capabilities ?? impliedCapabilities(config)

	let onMessage: ((m: MCPJsonRpcMessage) => void) | undefined
	let onClose: (() => void) | undefined
	let connected = false

	const send = (message: MCPJsonRpcMessage): void => {
		// A real transport delivers asynchronously; a same-tick reply would
		// let a caller observe "sent" and "answered" as one atomic step,
		// which no real transport can promise.
		queueMicrotask(() => onMessage?.(message))
	}

	function handle(message: MCPJsonRpcMessage): void {
		if (message.method === 'server/discover') {
			// No `supportedVersions`, so the era probe reads this as a fast,
			// clean "legacy" rather than waiting out the probe timeout —
			// this fixture speaks the pre-modern (2024-11-05-shaped) protocol.
			send({ jsonrpc: '2.0', id: message.id, result: {} })
			return
		}
		if (message.method === 'initialize') {
			send({
				jsonrpc: '2.0',
				id: message.id,
				result: {
					serverInfo: { name: serverName, version: '1' },
					capabilities,
					...(config.instructions !== undefined ? { instructions: config.instructions } : {}),
				},
			})
			return
		}
		if (message.id === undefined) return // a notification FROM the client; nothing here answers one

		switch (message.method) {
			case 'tools/list':
				send({ jsonrpc: '2.0', id: message.id, result: { tools } })
				return
			case 'tools/call': {
				const params = (message.params ?? {}) as {
					name: string
					arguments?: Record<string, unknown>
				}
				toolCalls.push({ name: params.name, args: params.arguments ?? {} })
				const scripted = config.toolResults?.[params.name]
				const result: unknown =
					scripted ??
					({ content: [{ type: 'text', text: `${params.name} ok` }] } satisfies MCPToolResult)
				send({ jsonrpc: '2.0', id: message.id, result })
				return
			}
			case 'prompts/list':
				send({ jsonrpc: '2.0', id: message.id, result: { prompts } })
				return
			case 'prompts/get': {
				const params = (message.params ?? {}) as { name: string }
				const prompt = prompts.find((p) => p.name === params.name)
				if (!prompt) {
					send({
						jsonrpc: '2.0',
						id: message.id,
						error: { code: -32602, message: `Unknown prompt: ${params.name}` },
					})
					return
				}
				send({
					jsonrpc: '2.0',
					id: message.id,
					result: {
						description: prompt.description,
						messages: [{ role: 'user', content: { type: 'text', text: `prompt:${prompt.name}` } }],
					},
				})
				return
			}
			case 'resources/list':
				send({ jsonrpc: '2.0', id: message.id, result: { resources } })
				return
			case 'resources/read': {
				const params = (message.params ?? {}) as { uri: string }
				resourceReads.push(params.uri)
				const resource = resources.find((r) => r.uri === params.uri)
				if (!resource) {
					send({
						jsonrpc: '2.0',
						id: message.id,
						error: { code: -32602, message: `Unknown resource: ${params.uri}` },
					})
					return
				}
				send({
					jsonrpc: '2.0',
					id: message.id,
					result: {
						contents: [
							{
								type: 'resource',
								resource: {
									uri: resource.uri,
									mimeType: resource.mimeType,
									text: `contents of ${resource.uri}`,
								},
							},
						],
					},
				})
				return
			}
			default:
				send({
					jsonrpc: '2.0',
					id: message.id,
					error: { code: -32601, message: `Method not found: ${message.method}` },
				})
		}
	}

	const transport: MCPTransport = {
		connect: async () => {
			connected = true
		},
		close: async () => {
			connected = false
		},
		send: async (message) => handle(message),
		onMessage: (h) => {
			onMessage = h
		},
		onClose: (h) => {
			onClose = h
		},
		onError: () => undefined,
		isConnected: () => connected,
	}

	const client = new MCPClient({
		serverName,
		// Never dialled: `transport` is swapped in below before `connect()`
		// runs, exactly like `client.test.ts`'s own harness. `command` still
		// has to satisfy the config type.
		transport: { type: 'stdio', command: 'unused' },
		eraCache: createMcpEraCache(),
	})
	;(client as unknown as { transport: MCPTransport }).transport = transport

	return {
		client,
		toolCalls,
		resourceReads,
		setTools: (next) => {
			tools = [...next]
		},
		setPrompts: (next) => {
			prompts = [...next]
		},
		setResources: (next) => {
			resources = [...next]
		},
		fireListChanged: (kind) =>
			send({ jsonrpc: '2.0', method: `notifications/${kind}/list_changed` }),
		dropConnection: () => {
			connected = false
			onClose?.()
		},
	}
}
