import type { MCPJsonRpcMessage, SandboxStdioChannel, SandboxStdioEvent } from '@namzu/sdk'
import { vi } from 'vitest'

export const GUEST_MCP_IMAGE =
	'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADUlEQVR4XmOoAAMoBQAnbgWhheklIAAAAABJRU5ErkJggg=='

export function guestMcpChannel(
	respond?: (message: MCPJsonRpcMessage) => MCPJsonRpcMessage | undefined,
) {
	const queue: SandboxStdioEvent[] = []
	let waiting: ((value: IteratorResult<SandboxStdioEvent>) => void) | undefined
	let ended = false
	let resolveClosed!: () => void
	const operations: {
		complete: ReturnType<typeof vi.fn>
		outcomeUnknown: ReturnType<typeof vi.fn>
	}[] = []
	const messages: MCPJsonRpcMessage[] = []
	const pushBytes = (data: Uint8Array, stream: 'stdout' | 'stderr' = 'stdout') => {
		const event = { stream, data }
		if (waiting) {
			const resolve = waiting
			waiting = undefined
			resolve({ done: false, value: event })
		} else queue.push(event)
	}
	const reply = (message: MCPJsonRpcMessage) =>
		pushBytes(Buffer.from(`${JSON.stringify(message)}\n`))
	const finish = () => {
		ended = true
		resolveClosed()
		if (waiting && queue.length === 0) {
			waiting({ done: true, value: undefined })
			waiting = undefined
		}
	}
	const channel: SandboxStdioChannel = {
		events: {
			[Symbol.asyncIterator]() {
				return {
					next() {
						const event = queue.shift()
						if (event) return Promise.resolve({ done: false as const, value: event })
						if (ended) return Promise.resolve({ done: true as const, value: undefined })
						return new Promise<IteratorResult<SandboxStdioEvent>>((resolve) => {
							waiting = resolve
						})
					},
				}
			},
		},
		closed: new Promise<void>((resolve) => {
			resolveClosed = resolve
		}),
		beginOperation: vi.fn(async (signal?: AbortSignal) => {
			signal?.throwIfAborted()
			const operation = { complete: vi.fn(), outcomeUnknown: vi.fn() }
			operations.push(operation)
			return operation
		}),
		write: vi.fn(async (data: string | Uint8Array, signal?: AbortSignal) => {
			signal?.throwIfAborted()
			const message = JSON.parse(
				typeof data === 'string' ? data : Buffer.from(data).toString('utf8'),
			) as MCPJsonRpcMessage
			messages.push(message)
			const result = respond?.(message)
			if (result) reply(result)
		}),
		close: vi.fn(async () => {
			finish()
		}),
	}
	return { channel, operations, messages, reply, pushBytes, finish }
}

export function guestMcpResponse(message: MCPJsonRpcMessage): MCPJsonRpcMessage | undefined {
	if (message.id === undefined) return undefined
	if (message.method === 'server/discover')
		return {
			jsonrpc: '2.0',
			id: message.id,
			error: { code: -32601, message: 'Legacy guest server' },
		}
	let result: unknown
	if (message.method === 'initialize') {
		result = {
			protocolVersion: message.params?.protocolVersion,
			capabilities: { tools: { listChanged: true } },
			serverInfo: { name: 'guest-only-fixture', version: '1' },
		}
	} else if (message.method === 'tools/list') {
		result = {
			tools: [
				{
					name: 'inspect_scene',
					description: 'Look at guest scene',
					inputSchema: { type: 'object', properties: {} },
					annotations: { readOnlyHint: true },
				},
				{
					name: 'paid_generate',
					description: 'Never mounted',
					inputSchema: { type: 'object', properties: {} },
				},
			],
		}
	} else if (message.method === 'tools/call') {
		result = {
			_meta: { 'namzu/outcome': 'settled' },
			content: [
				{ type: 'text', text: 'Actual guest scene' },
				{ type: 'image', data: GUEST_MCP_IMAGE, mimeType: 'image/png' },
			],
		}
	} else result = {}
	return { jsonrpc: '2.0', id: message.id, result }
}
