import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { mcpToolToToolDefinition } from '../../../connector/mcp/adapter.js'
import { MCPClient } from '../../../connector/mcp/client.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type {
	MCPJsonRpcMessage,
	MCPTransport,
	MCPTransportSendOptions,
	MCPTransportUnion,
} from '../../../types/connector/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * Adapter and client tests can both pass while the production composition
 * drops the signal between them. This drives the real query/tool executor,
 * real MCP adapter and real MCP client, then observes the private transport.
 */
describe('MCP cancellation reaches a real run', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	it('stops the correlated MCP request and asks the peer to cancel', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-mcp-cancel-'))
		workdirs.push(workingDirectory)
		let receive: ((message: MCPJsonRpcMessage) => void) | undefined
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let privateSignal: AbortSignal | undefined
		let requestId: string | number | undefined
		const cancellations: MCPJsonRpcMessage[] = []
		const transport: MCPTransport = {
			connect: async () => {},
			close: async () => {},
			isConnected: () => true,
			send: (message, options?: MCPTransportSendOptions) => {
				if (message.method === 'initialize') {
					receive?.({
						jsonrpc: '2.0',
						id: message.id,
						result: {
							protocolVersion: '2024-11-05',
							serverInfo: { name: 'fixture' },
							capabilities: { tools: {} },
						},
					})
					return Promise.resolve()
				}
				if (message.method === 'notifications/cancelled') {
					cancellations.push(message)
					return Promise.resolve()
				}
				if (message.method !== 'tools/call') return Promise.resolve()
				requestId = message.id
				privateSignal = options?.signal
				markStarted()
				return new Promise((_resolve, reject) => {
					privateSignal?.addEventListener(
						'abort',
						() =>
							reject(
								Object.assign(new Error('generic transport abort'), {
									name: 'AbortError',
								}),
							),
						{ once: true },
					)
				})
			},
			onMessage: (handler) => {
				receive = handler
			},
			onClose: () => {},
			onError: () => {},
		}
		const client = new MCPClient({
			serverName: 'fixture',
			requestTimeoutMs: 60_000,
			transport: { type: 'stdio', command: 'unused' } as MCPTransportUnion,
		})
		;(client as unknown as { transport: MCPTransport }).transport = transport
		await client.connect()

		const tools = new ToolRegistry()
		tools.register(
			mcpToolToToolDefinition(
				{
					name: 'remote_mutation',
					description: 'Perform a remote mutation',
					inputSchema: { type: 'object' },
				},
				client,
				'fixture',
			),
		)
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{
							id: 'call_mcp',
							name: 'mcp_fixture_remote_mutation',
							args: { value: 1 },
						},
					],
					finishReason: 'tool_calls',
				},
				{ text: 'a stopped request must not produce another model turn' },
			],
		})
		const caller = new AbortController()
		const pending = drainQuery({
			provider,
			tools,
			runConfig: {
				model: 'mock-model',
				timeoutMs: 10_000,
				tokenBudget: 100_000,
				maxIterations: 4,
				maxResponseTokens: 256,
				permissionMode: 'auto',
			},
			toolTimeoutMs: 60_000,
			agentId: 'agent_mcp_cancel',
			agentName: 'MCP Cancellation',
			messages: [createUserMessage('run the remote tool')],
			workingDirectory,
			sessionId: 'ses_mcp_cancel' as SessionId,
			topicId: 'top_mcp_cancel' as TopicId,
			projectId: 'prj_mcp_cancel' as ProjectId,
			tenantId: 'tnt_mcp_cancel' as TenantId,
			signal: caller.signal,
		})

		await started
		const reason = new Error('operator stopped MCP tool')
		caller.abort(reason)
		const run = await Promise.race([
			pending,
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error('MCP cancellation did not settle the run')), 1_000)
			}),
		])
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(provider.requests).toHaveLength(1)
		expect(privateSignal).toBeDefined()
		expect(privateSignal).not.toBe(caller.signal)
		expect(privateSignal?.aborted).toBe(true)
		expect(privateSignal?.reason).toBe(reason)
		expect(
			(client as unknown as { pendingRequests: Map<unknown, unknown> }).pendingRequests.size,
		).toBe(0)
		expect(cancellations).toEqual([
			{
				jsonrpc: '2.0',
				method: 'notifications/cancelled',
				params: { requestId, reason: 'Caller cancelled request' },
			},
		])
	})
})
