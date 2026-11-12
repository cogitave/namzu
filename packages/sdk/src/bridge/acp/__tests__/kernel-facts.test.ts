import { describe, expect, it } from 'vitest'
import { DATA_EPOCH } from '../../../constants/data-epoch.js'
import { HostCommandRegistry } from '../../../registry/command/index.js'
import { createToolPresenter } from '../../../registry/tool/presentation.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { AcpHostKernelFacts, AcpInitializeResult } from '../../../types/acp/index.js'
import type { MCPJsonRpcMessage, MCPTransport } from '../../../types/connector/mcp.js'
import { VERSION } from '../../../version.js'
import { ACPServer } from '../server.js'

async function initialize(kernelFacts?: AcpHostKernelFacts): Promise<AcpInitializeResult> {
	let handler: ((message: MCPJsonRpcMessage) => void) | undefined
	let reply: ((message: MCPJsonRpcMessage) => void) | undefined
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
			if (message.id === 1) reply?.(message)
		},
	}
	const server = new ACPServer({
		transport,
		gateway: { prompt: async () => ({ stopReason: 'end_turn' }), load: async () => [] },
		commands: new HostCommandRegistry(),
		presenter: createToolPresenter(new ToolManager({ toolsets: [], messages: () => [] })),
		agentInfo: { name: 'namzu', version: 'test' },
		...(kernelFacts ? { kernelFacts } : {}),
	})
	await server.start()
	const answer = new Promise<MCPJsonRpcMessage>((resolve) => {
		reply = resolve
	})
	handler?.({
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: { capabilities: ['permission'] },
	})
	const message = await answer
	await server.stop()
	return message.result as AcpInitializeResult
}

describe('initialize states the kernel facts', () => {
	it('answers with the engine version and the data epoch when the host adds nothing', async () => {
		const result = await initialize()
		expect(result.kernel).toEqual({ engine: VERSION, dataEpoch: DATA_EPOCH })
		expect(Object.keys(result.kernel ?? {}).sort()).toEqual(['dataEpoch', 'engine'])
	})

	it('adds the two facts a host application states, and only those it gives', async () => {
		expect((await initialize({ commandLine: '51.1.0' })).kernel).toEqual({
			engine: VERSION,
			dataEpoch: DATA_EPOCH,
			commandLine: '51.1.0',
		})
		expect((await initialize({ commandLine: '51.1.0', desktopContract: 1 })).kernel).toEqual({
			engine: VERSION,
			dataEpoch: DATA_EPOCH,
			commandLine: '51.1.0',
			desktopContract: 1,
		})
	})

	it('leaves every earlier field of the answer where it was', async () => {
		const result = await initialize({ desktopContract: 1 })
		expect(result.protocolVersion).toBe(1)
		expect(result.agentInfo).toEqual({ name: 'namzu', version: 'test' })
		expect(result.requiredClientCapabilities).toEqual(['permission'])
	})
})
