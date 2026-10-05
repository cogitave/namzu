import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

interface Rpc {
	jsonrpc: '2.0'
	id: string
	method?: string
	result?: unknown
	error?: unknown
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
	handler?: () => Promise<Record<string, unknown>>
	setRequestHandler(_schema: unknown, handler: () => Promise<Record<string, unknown>>): void {
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
