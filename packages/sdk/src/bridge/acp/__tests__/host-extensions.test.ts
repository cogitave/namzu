import { describe, expect, it, vi } from 'vitest'
import { HostCommandRegistry } from '../../../registry/command/index.js'
import { createToolPresenter } from '../../../registry/tool/presentation.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { MCPJsonRpcMessage, MCPTransport } from '../../../types/connector/mcp.js'
import { ACPServer } from '../server.js'

function harness(extensions: Record<string, (params: Record<string, unknown>) => unknown>) {
	let handler: ((message: MCPJsonRpcMessage) => void) | undefined
	const pending = new Map<number, (message: MCPJsonRpcMessage) => void>()
	const transport: MCPTransport = {
		connect: async () => {},
		close: async () => {},
		isConnected: () => true,
		onMessage: (next) => {
			handler = next
		},
		onClose: () => {},
		onError: () => {},
		send: async (message) => {
			if (typeof message.id === 'number') pending.get(message.id)?.(message)
		},
	}
	const load = vi.fn(async (_id: string, _cwd?: string) => [])
	const server = new ACPServer({
		transport,
		extensions,
		gateway: { prompt: async () => ({ stopReason: 'end_turn' }), load },
		commands: new HostCommandRegistry(),
		presenter: createToolPresenter(new ToolManager({ toolsets: [], messages: () => [] })),
		agentInfo: { name: 'namzu', version: 'test' },
	})
	let seq = 0
	const request = (method: string, params: Record<string, unknown> = {}) =>
		new Promise<MCPJsonRpcMessage>((resolve) => {
			const id = ++seq
			pending.set(id, (message) => {
				pending.delete(id)
				resolve(message)
			})
			handler?.({ jsonrpc: '2.0', id, method, params })
		})
	return { server, request, load }
}

describe('explicit ACP host extensions', () => {
	it('requires initialized permission negotiation and advertises installed methods', async () => {
		const action = vi.fn(() => ({ ready: true }))
		const h = harness({ 'namzu/project/status': action })
		await h.server.start()
		expect((await h.request('namzu/project/status')).error).toBeDefined()
		expect(action).not.toHaveBeenCalled()
		const result = await h.request('initialize', {
			capabilities: ['permission'],
		})
		expect(result.result).toMatchObject({
			extensions: ['namzu/project/status'],
		})
		expect((await h.request('namzu/project/status')).result).toEqual({
			ready: true,
		})
		expect((await h.request('__proto__')).error?.code).toBe(-32601)
		await h.server.stop()
	})
	it('refuses extensions when a client cannot answer a permission request', async () => {
		const action = vi.fn()
		const h = harness({ 'namzu/project/trust': action })
		await h.server.start()
		await h.request('initialize', { capabilities: [] })
		expect((await h.request('namzu/project/trust')).error).toBeDefined()
		expect(action).not.toHaveBeenCalled()
		await h.server.stop()
	})
	it('cannot replace core methods and passes the requested workspace to history loading', async () => {
		expect(() => harness({ initialize: () => ({}) })).toThrow('Invalid ACP host extension')
		const h = harness({})
		await h.server.start()
		await h.request('initialize', { capabilities: ['permission'] })
		await h.request('session/load', {
			sessionId: 'history',
			cwd: '/tmp/owned-workspace',
		})
		expect(h.load).toHaveBeenCalledWith('history', '/tmp/owned-workspace')
		await h.server.stop()
	})
})
