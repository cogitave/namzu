import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { ToolManager, mcpToolToToolDefinition, toolset } from '@namzu/sdk'
import type { MCPClient, MCPToolDefinition, MCPToolResult, ToolContext } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface Rpc {
	jsonrpc: '2.0'
	id: string
	method?: string
	params?: unknown
	result?: unknown
	error?: unknown
}
interface ToolRequest {
	method: string
	params: { name?: string; arguments?: unknown }
}
interface Guard {
	unknown: boolean
	run(handler: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>>
	installWebSocket(socket: typeof EditorSocket): () => void
	installServer(server: typeof RpcServer): () => void
}
const require = createRequire(import.meta.url)
const { GodotOutcomeGuard, adaptModule } = require('../../../assets/pal-godot-mcp.cjs') as {
	GodotOutcomeGuard: new () => Guard
	adaptModule(relative: string, source: string): string
}
const cleanups: (() => void)[] = []
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

class EditorSocket extends EventEmitter {
	readonly sent: Rpc[] = []
	failWrite = false
	send(data: string, callback?: (error?: Error) => void): void {
		this.sent.push(JSON.parse(data) as Rpc)
		callback?.(this.failWrite ? new Error('Editor socket delivery failed') : undefined)
	}
	reply(rpc: Rpc): void {
		this.emit('message', Buffer.from(JSON.stringify(rpc)))
	}
}
class RpcServer {
	handler?: (request?: ToolRequest) => Promise<Record<string, unknown>>
	setRequestHandler(
		_schema: unknown,
		handler: (request?: ToolRequest) => Promise<Record<string, unknown>>,
	): void {
		this.handler = handler
	}
}
function setup() {
	const guard = new GodotOutcomeGuard()
	cleanups.push(guard.installWebSocket(EditorSocket))
	return { guard, socket: new EditorSocket() }
}
const send = (socket: EditorSocket, id = 'request-a') =>
	socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'scene.create_node' }), () => {})
const result = () => ({
	content: [{ type: 'text', text: 'application response' }],
})
const outcome = (value: Record<string, unknown>) =>
	(value._meta as Record<string, unknown>)['namzu/outcome']

describe('Godot editor effect confirmation', () => {
	it('confirms only an exact application reply and retains rich output', async () => {
		const { guard, socket } = setup()
		const image = { type: 'image', data: 'Zm9v', mimeType: 'image/png' }
		const value = await guard.run(async () => {
			send(socket)
			socket.reply({
				jsonrpc: '2.0',
				id: 'request-a',
				result: { success: true },
			})
			return { ...result(), content: [image], _meta: { source: 'editor' } }
		})
		expect(outcome(value)).toBe('settled')
		expect(value.content).toEqual([image])
		expect(value._meta).toMatchObject({ source: 'editor' })
		expect(guard.unknown).toBe(false)
	})
	it('allows repair of a known application error after the editor returned', async () => {
		const { guard, socket } = setup()
		const value = await guard.run(async () => {
			send(socket)
			socket.reply({
				jsonrpc: '2.0',
				id: 'request-a',
				result: { success: false, code: 'INVALID_NODE' },
			})
			return { ...result(), isError: true }
		})
		expect(outcome(value)).toBe('settled')
		expect(value.isError).toBe(true)
		expect(guard.unknown).toBe(false)
		expect(outcome(await guard.run(async () => result()))).toBe('not_dispatched')
	})
	it('identifies a local refusal before dispatch without fencing the computer', async () => {
		const { guard, socket } = setup()
		const value = await guard.run(async () => {
			throw new Error('Invalid input before editor dispatch')
		})
		expect(outcome(value)).toBe('not_dispatched')
		expect(value.isError).toBe(true)
		expect(socket.sent).toHaveLength(0)
		expect(guard.unknown).toBe(false)
	})
	it('keeps a mutation watchdog reply uncertain despite a later application reply', async () => {
		const { guard, socket } = setup()
		const value = await guard.run(async () => {
			send(socket)
			socket.reply({
				jsonrpc: '2.0',
				id: 'request-a',
				error: { code: -32000, message: 'watchdog recovered dispatch' },
			})
			socket.reply({
				jsonrpc: '2.0',
				id: 'request-a',
				result: { success: true },
			})
			return result()
		})
		expect(outcome(value)).toBe('unknown')
		expect(value.isError).toBe(true)
		let nextExecuted = false
		const next = await guard.run(async () => {
			nextExecuted = true
			return result()
		})
		expect(nextExecuted).toBe(false)
		expect(outcome(next)).toBe('unknown')
	})
	it('does not infer completion from another request or from positive MCP text', async () => {
		const { guard, socket } = setup()
		const value = await guard.run(async () => {
			send(socket)
			socket.reply({
				jsonrpc: '2.0',
				id: 'another-request',
				result: { success: true },
			})
			return {
				content: [
					{
						type: 'text',
						text: 'Error communicating with editor: no data received',
					},
				],
			}
		})
		expect(outcome(value)).toBe('unknown')
	})
	it('fences uncertain socket delivery', async () => {
		const { guard, socket } = setup()
		socket.failWrite = true
		const writeFailed = await guard.run(async () => {
			send(socket)
			return result()
		})
		expect(outcome(writeFailed)).toBe('unknown')
	})
	it('fences a disconnect with pending editor work', async () => {
		const { guard, socket } = setup()
		const lost = await guard.run(async () => {
			send(socket)
			socket.emit('close')
			return result()
		})
		expect(outcome(lost)).toBe('unknown')
	})
	it('does not fence an idle socket, and blocks unadmitted editor mutations', async () => {
		const { guard, socket } = setup()
		socket.emit('close')
		expect(guard.unknown).toBe(false)
		expect(() => send(socket)).toThrow('active owned MCP request')
		expect(socket.sent).toHaveLength(0)
		socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'heartbeat', method: 'ping' }))
		expect(socket.sent).toHaveLength(1)
		expect(guard.unknown).toBe(false)
	})
	it('blocks editor work retained in an async context after its MCP request ended', async () => {
		const { guard, socket } = setup()
		let release!: () => void
		const deferred = new Promise<void>((resolve) => {
			release = resolve
		})
		let tail!: Promise<void>
		const value = await guard.run(async () => {
			tail = (async () => {
				await deferred
				send(socket)
			})()
			return result()
		})
		release()
		await expect(tail).rejects.toThrow('active owned MCP request')
		expect(outcome(value)).toBe('not_dispatched')
		expect(socket.sent).toHaveLength(0)
	})
	it('marks the actual MCP request handler response', async () => {
		const { guard, socket } = setup()
		cleanups.push(guard.installServer(RpcServer))
		const server = new RpcServer()
		server.setRequestHandler({}, async () => {
			send(socket)
			socket.reply({
				jsonrpc: '2.0',
				id: 'request-a',
				result: { success: true },
			})
			return result()
		})
		if (!server.handler) throw new Error('The MCP handler was not installed')
		expect(outcome(await server.handler())).toBe('settled')
	})
})

describe('Godot input constructor preflight', () => {
	const inputRequest = (args: unknown): ToolRequest => ({
		method: 'tools/call',
		params: { name: 'input_simulate', arguments: args },
	})
	const key = (pressed: unknown) => ({
		event_type: 'key',
		event_data: { keycode: '82', physical_keycode: '82', pressed },
	})
	const inputSend = (socket: EditorSocket, params: unknown) =>
		socket.send(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 'input',
				method: 'input.simulate',
				params,
			}),
		)
	function originalServer(
		guard: Guard,
		handler: (request?: ToolRequest) => Promise<Record<string, unknown>>,
	) {
		cleanups.push(guard.installServer(RpcServer))
		const server = new RpcServer()
		server.setRequestHandler({}, handler)
		if (!server.handler) throw new Error('The MCP handler was not installed')
		return server.handler
	}

	it.each(['true', 'false', null, {}, []])(
		'refuses the entire actual tools/call batch before its original handler for pressed=%j',
		async (pressed) => {
			const { guard, socket } = setup()
			const original = vi.fn(async (request?: ToolRequest) => {
				if (!request) throw new Error('Missing MCP request')
				inputSend(socket, request.params.arguments)
				socket.reply({
					jsonrpc: '2.0',
					id: 'input',
					result: { success: true },
				})
				return result()
			})
			const handler = originalServer(guard, original)
			const args = { events: [key(true), key(false), key(pressed)] }
			const refused = await handler(inputRequest(args))
			expect(outcome(refused)).toBe('not_dispatched')
			expect(refused.isError).toBe(true)
			expect(JSON.stringify(refused.content)).toContain('events[2].event_data.pressed')
			expect(JSON.stringify(refused.content)).toContain('JSON boolean true/false')
			expect(original).not.toHaveBeenCalled()
			expect(socket.sent).toHaveLength(0)
			expect(guard.unknown).toBe(false)
			// The model can correct a refused call; no original input is replayed.
			const corrected = { events: [key(true), key(false)] }
			expect(outcome(await handler(inputRequest(corrected)))).toBe('settled')
			expect(socket.sent).toHaveLength(1)
			expect(socket.sent[0]).toMatchObject({ params: corrected })
			expect(args.events[2]?.event_data.pressed).toBe(pressed)
		},
	)

	it('also refuses a malformed last event at the actual WebSocket send boundary', async () => {
		const { guard, socket } = setup()
		const refused = await guard.run(async () => {
			inputSend(socket, { events: [key(true), key('false')] })
			return result()
		})
		expect(outcome(refused)).toBe('not_dispatched')
		expect(refused.isError).toBe(true)
		expect(socket.sent).toHaveLength(0)
		expect(guard.unknown).toBe(false)
	})

	it.each([
		{
			event_type: 'mouse_button',
			event_data: { shift: 'false' },
			field: 'shift',
		},
		{ event_type: 'click', event_data: { ctrl: null }, field: 'ctrl' },
		{ event_type: 'action', event_data: { pressed: 'true' }, field: 'pressed' },
		{ event_type: 'send_text', event_data: { submit: [] }, field: 'submit' },
		{
			event_type: 'mouse_motion',
			event_data: { position: { x: null } },
			field: 'position.x',
		},
		{
			event_type: 'mouse_motion',
			event_data: { world_position: { y: {} } },
			field: 'world_position.y',
		},
	])(
		'names the consumed constructor field before calling upstream: $event_type $field',
		async ({ event_type, event_data, field }) => {
			const { guard, socket } = setup()
			const original = vi.fn(async () => result())
			const handler = originalServer(guard, original)
			const refused = await handler(inputRequest({ events: { event_type, event_data } }))
			expect(outcome(refused)).toBe('not_dispatched')
			expect(JSON.stringify(refused.content)).toContain(`events[0].event_data.${field}`)
			expect(original).not.toHaveBeenCalled()
			expect(socket.sent).toHaveLength(0)
		},
	)

	it('preserves defaults, native numeric casts, null coordinate/default dictionaries and ignored fields on the wire', async () => {
		const { guard, socket } = setup()
		const params = {
			summary: 0,
			events: [
				key(true),
				key(false),
				key(0),
				key(-0.5),
				{ event_type: 'key', event_data: null },
				{ event_type: 'key' },
				{
					event_type: 'mouse_button',
					event_data: {
						pressed: 1,
						shift: false,
						position: null,
						x: '2',
						y: 3,
					},
				},
				{
					event_type: 'click',
					event_data: {
						pressed: {},
						alt: 0,
						click_delay_ms: '50',
						world_position: null,
					},
				},
				{
					event_type: 'mouse_motion',
					event_data: { pressed: 'false', shift: {}, relative: null },
				},
				{
					event_type: 'action',
					event_data: { action: 'move_up', pressed: -1, strength: '0.5' },
				},
				{
					event_type: 'send_text',
					event_data: {
						text: { preserved: true },
						submit: 0,
						unknown: { arbitrary: ['data'] },
					},
				},
				{
					event_type: 'click_node',
					event_data: {
						node_path: '/root/Main',
						pressed: 'true',
						submit: null,
					},
				},
			],
		}
		const snapshot = structuredClone(params)
		const value = await guard.run(async () => {
			inputSend(socket, params)
			socket.reply({ jsonrpc: '2.0', id: 'input', result: { success: true } })
			return result()
		})
		expect(outcome(value)).toBe('settled')
		expect(socket.sent[0]).toMatchObject({ params })
		expect(params).toEqual(snapshot)
		expect(guard.unknown).toBe(false)
	})

	it('inspects encoded events without changing upstream summary/delay coercion or original arguments', async () => {
		const { guard } = setup()
		const original = vi.fn(async () => result())
		const handler = originalServer(guard, original)
		const valid = inputRequest({
			events: JSON.stringify({ ...key(false), delay_after_ms: '25' }),
			summary: 'false',
		})
		expect(outcome(await handler(valid))).toBe('not_dispatched')
		expect(original).toHaveBeenCalledWith(valid, undefined)
		original.mockClear()
		const invalid = inputRequest({
			events: JSON.stringify([key(true), key('false')]),
		})
		expect((await handler(invalid)).isError).toBe(true)
		expect(original).not.toHaveBeenCalled()
	})

	it('does not inspect similarly named arguments of other tools or clear an existing unknown result', async () => {
		const { guard, socket } = setup()
		const original = vi.fn(async () => result())
		const handler = originalServer(guard, original)
		const other: ToolRequest = {
			method: 'tools/call',
			params: { name: 'execute_code', arguments: { events: [key('true')] } },
		}
		expect(outcome(await handler(other))).toBe('not_dispatched')
		expect(original).toHaveBeenCalledTimes(1)
		await guard.run(async () => {
			send(socket)
			return result()
		})
		original.mockClear()
		const refused = await handler(inputRequest({ events: [key('false')] }))
		expect(outcome(refused)).toBe('unknown')
		expect(refused.isError).toBe(true)
		expect(original).not.toHaveBeenCalled()
		expect(guard.unknown).toBe(true)
	})
})

describe('Godot typed input advertisement', () => {
	const eventSchema = {
		type: 'object',
		properties: {
			event_type: {
				type: 'string',
				enum: ['key', 'mouse_button', 'mouse_motion', 'action', 'click', 'click_node', 'send_text'],
			},
			event_data: {
				type: 'object',
				propertyNames: { type: 'string' },
				additionalProperties: {},
			},
			delay_before_ms: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
			delay_after_ms: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
		},
		required: ['event_type'],
	}
	const inputTool: MCPToolDefinition & { execution: { taskSupport: 'forbidden' } } = {
		name: 'input_simulate',
		description: 'Inject input into the running game.',
		annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
		execution: { taskSupport: 'forbidden' },
		inputSchema: {
			type: 'object',
			properties: {
				events: {
					anyOf: [eventSchema, { type: 'array', items: eventSchema, minItems: 1 }],
				},
				summary: { type: 'boolean' },
			},
			required: ['events'],
		},
	}
	const otherTool: MCPToolDefinition = {
		name: 'runtime_screenshot',
		description: 'Capture the running game.',
		inputSchema: { type: 'object', properties: { save_path: { type: 'string' } } },
	}
	const listing = { tools: [otherTool, inputTool], nextCursor: 'next-page' }
	function wrappedApi() {
		const { guard, socket } = setup()
		cleanups.push(guard.installServer(RpcServer))
		const server = new RpcServer()
		const originalCall = vi.fn(async (args: unknown) => {
			const input = args as { events: unknown; summary?: boolean }
			const events = typeof input.events === 'string' ? JSON.parse(input.events) : input.events
			const params = { ...input, events: Array.isArray(events) ? events : [events] }
			socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'input', method: 'input.simulate', params }))
			socket.reply({ jsonrpc: '2.0', id: 'input', result: { success: true } })
			return result()
		})
		server.setRequestHandler({}, async (request) => {
			if (request?.method === 'tools/list') return listing
			if (request?.method === 'tools/call' && request.params.name === 'input_simulate')
				return originalCall(request.params.arguments)
			throw new Error('Unexpected fixture request')
		})
		if (!server.handler) throw new Error('The MCP handler was not installed')
		const handler = server.handler
		const callTool = vi.fn(
			async (name: string, args: unknown): Promise<MCPToolResult> =>
				(await handler({
					method: 'tools/call',
					params: { name, arguments: args },
				})) as unknown as MCPToolResult,
		)
		return { handler, originalCall, callTool, socket, guard }
	}
	async function sdkCaller() {
		const api = wrappedApi()
		const response = await api.handler({ method: 'tools/list', params: {} })
		const advertised = (response.tools as MCPToolDefinition[]).find(
			(tool) => tool.name === 'input_simulate',
		)
		if (!advertised) throw new Error('Missing installed input tool')
		const tool = mcpToolToToolDefinition(
			advertised,
			{ callTool: api.callTool } as unknown as MCPClient,
			'godot',
		)
		const manager = new ToolManager({ toolsets: [toolset('fixture', [tool])], messages: () => [] })
		const context = { abortSignal: new AbortController().signal } as ToolContext
		return { ...api, advertised, tool, manager, context }
	}

	it('clones only input_simulate on every actual listing and retains its existing contract', async () => {
		const { handler } = wrappedApi()
		const snapshot = structuredClone(listing)
		const first = await handler({ method: 'tools/list', params: {} })
		const second = await handler({ method: 'tools/list', params: {} })
		const tools = first.tools as MCPToolDefinition[]
		expect(tools[0]).toBe(otherTool)
		expect(tools[1]).not.toBe(inputTool)
		expect(listing).toEqual(snapshot)
		expect(first.nextCursor).toBe('next-page')
		expect(second).toEqual(first)
		expect(tools[1]?.annotations).toBe(inputTool.annotations)
		expect(tools[1]).toHaveProperty('execution', inputTool.execution)
		expect(tools[1]?.description).toContain('strength:0 does NOT release')
		expect(tools[1]?.inputSchema).not.toHaveProperty('additionalProperties')
		expect(tools[1]?.inputSchema).toMatchObject({
			required: ['events'],
			properties: {
				summary: { type: 'boolean' },
				events: {
					anyOf: [
						{
							anyOf: [
								{
									required: ['event_type'],
									properties: {
										event_type: { enum: ['key'] },
										event_data: {
											additionalProperties: {},
											propertyNames: { type: 'string' },
											properties: {
												pressed: { anyOf: [{ type: 'boolean' }, { type: 'number' }] },
											},
										},
										delay_before_ms: { type: 'integer', minimum: 0 },
										delay_after_ms: { type: 'integer', minimum: 0 },
									},
								},
								...Array.from({ length: 6 }, () => ({})),
							],
						},
						{ type: 'array', minItems: 1 },
						{ type: 'string' },
					],
				},
			},
		})
	})

	it('carries typed false and numeric zero through the SDK and actual caller without injecting defaults', async () => {
		const { manager, context, tool, callTool, originalCall, socket } = await sdkCaller()
		const args = {
			events: [
				{ event_type: 'key', event_data: { keycode: '82', pressed: false } },
				{ event_type: 'action', event_data: { action: 'restart', pressed: 0, strength: '0' } },
				{ event_type: 'mouse_button', event_data: { pressed: false, shift: false } },
				{ event_type: 'send_text', event_data: { text: 'literal', submit: false } },
				{ event_type: 'key' },
			],
			summary: true,
		}
		const rendered = manager.toLLMTools()[0]?.function.parameters
		expect(rendered).toMatchObject({
			additionalProperties: false,
			properties: {
				events: {
					anyOf: [
						{
							anyOf: [
								{
									properties: {
										event_type: { enum: ['key'] },
										event_data: {
											additionalProperties: {},
											properties: {
												pressed: { type: ['boolean', 'number'] },
											},
										},
									},
								},
								...Array.from({ length: 6 }, () => ({})),
							],
						},
						{},
						{ type: 'string' },
					],
				},
			},
		})
		expect((await manager.execute(tool.name, args, context)).success).toBe(true)
		expect(callTool).toHaveBeenCalledWith('input_simulate', args, expect.any(Object))
		expect(originalCall).toHaveBeenCalledWith(args)
		expect(socket.sent[0]?.params).toEqual(args)
	})

	it('preserves flags ignored by other event kinds through SDK conversion and dispatch', async () => {
		const { manager, context, tool, originalCall, socket } = await sdkCaller()
		const args = {
			events: [
				{ event_type: 'click', event_data: { pressed: {}, ctrl: false } },
				{ event_type: 'mouse_motion', event_data: { pressed: 'false', shift: { kept: true } } },
				{ event_type: 'click_node', event_data: { node_path: '/root/Main', submit: null } },
			],
		}
		expect((await manager.execute(tool.name, args, context)).success).toBe(true)
		expect(originalCall).toHaveBeenCalledWith(args)
		expect(socket.sent[0]?.params).toEqual(args)
	})

	it('rejects a consumed boolean string in the SDK before any actual caller dispatch', async () => {
		const { manager, context, tool, callTool, originalCall, socket, guard } = await sdkCaller()
		const args = {
			events: [
				{ event_type: 'action', event_data: { action: 'restart', pressed: true } },
				{ event_type: 'action', event_data: { action: 'restart', pressed: 'false' } },
			],
		}
		expect((await manager.execute(tool.name, args, context)).success).toBe(false)
		expect(callTool).not.toHaveBeenCalled()
		expect(originalCall).not.toHaveBeenCalled()
		expect(socket.sent).toHaveLength(0)
		expect(guard.unknown).toBe(false)
	})

	it('retains encoded top-level compatibility while preflight refuses invalid nested encoded booleans', async () => {
		const { manager, context, tool, originalCall, socket, guard } = await sdkCaller()
		const valid = {
			events: JSON.stringify({ event_type: 'key', event_data: { keycode: 82, pressed: false } }),
		}
		expect((await manager.execute(tool.name, valid, context)).success).toBe(true)
		expect(originalCall).toHaveBeenCalledWith(valid)
		expect(socket.sent[0]?.params).toEqual({ events: [JSON.parse(valid.events)] })
		originalCall.mockClear()
		const invalid = {
			events: JSON.stringify([
				{ event_type: 'key', event_data: { keycode: 82, pressed: true } },
				{ event_type: 'key', event_data: { keycode: 82, pressed: 'false' } },
			]),
		}
		expect((await manager.execute(tool.name, invalid, context)).success).toBe(false)
		expect(originalCall).not.toHaveBeenCalled()
		expect(socket.sent).toHaveLength(1)
		expect(guard.unknown).toBe(false)
	})
})

describe('pinned Godot module adaptations', () => {
	it('disables automatic and hot reconnect and removes unadmitted startup RPCs', () => {
		const channel = adaptModule(
			'dist/transport/channel.js',
			'const noReconnect = opts?.noReconnect ?? false;\nif (!hasConnectedOnce)\n            return connect();',
		)
		expect(channel).toContain('const noReconnect = true;')
		expect(channel).toContain('Owned Godot bridge cannot reconnect')
		const index = adaptModule(
			'dist/index.js',
			'const { timedOut } = await extensions.discoverEagerly();\ndiscover: extensions.discoverExtensions',
		)
		expect(index).toContain('const timedOut = false;')
		expect(index).toContain('discover: async () => {}')
		expect(() => adaptModule('dist/transport/channel.js', 'an unreviewed implementation')).toThrow(
			'no longer matches',
		)
	})
})
