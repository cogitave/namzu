import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { WebhookConnector } from '../../../connector/builtins/webhook.js'
import { createConnectorExecuteTool } from '../../../connector/tools/definitions.js'
import { ConnectorManager } from '../../../manager/connector/lifecycle.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ConnectorRegistry } from '../../../registry/connector/definitions.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * Unit tests can prove every connector layer accepts a signal while the
 * production composition still drops it. This drives the public connector
 * tool through a real query and observes the private HTTP transport.
 */
describe('connector cancellation reaches a real run', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		vi.unstubAllGlobals()
		await removeTempDirs(workdirs)
		workdirs = []
	})

	it('stops the connector transport with the run cancellation cause', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-connector-cancel-'))
		workdirs.push(workingDirectory)
		let markStarted: (() => void) | undefined
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let transportSignal: AbortSignal | undefined
		const fetchMock = vi.fn(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					transportSignal = init.signal as AbortSignal
					transportSignal.addEventListener(
						'abort',
						() =>
							reject(Object.assign(new Error('generic transport abort'), { name: 'AbortError' })),
						{ once: true },
					)
					markStarted?.()
				}),
		)
		vi.stubGlobal('fetch', fetchMock)

		const connector = new WebhookConnector()
		const connectorRegistry = new ConnectorRegistry()
		connectorRegistry.register(connector.toDefinition())
		const connectorManager = new ConnectorManager({ registry: connectorRegistry })
		const instance = await connectorManager.createInstance(
			{
				connectorId: connector.id,
				name: 'run webhook',
				options: { url: 'https://hook.example.com', timeoutMs: 60_000 },
			},
			connector,
		)
		await connectorManager.connect(instance.id)

		const tools = new ToolRegistry()
		tools.register(createConnectorExecuteTool({ manager: connectorManager }))
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{
							id: 'call_connector',
							name: 'connector_execute',
							args: {
								instance_id: instance.id,
								method: 'send',
								input: { payload: { event: 'run' } },
							},
						},
					],
					finishReason: 'tool_calls',
				},
				{ text: 'the stopped run must not need another model turn' },
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
			agentId: 'agent_connector_cancel',
			agentName: 'Connector Cancellation',
			messages: [createUserMessage('send the webhook')],
			workingDirectory,
			sessionId: 'ses_connector_cancel' as SessionId,
			topicId: 'top_connector_cancel' as TopicId,
			projectId: 'prj_connector_cancel' as ProjectId,
			tenantId: 'tnt_connector_cancel' as TenantId,
			signal: caller.signal,
		})

		await started
		const reason = new Error('operator stopped connector delivery')
		caller.abort(reason)
		const run = await Promise.race([
			pending,
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error('connector cancellation did not settle the run')), 1_000)
			}),
		])

		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(provider.requests).toHaveLength(1)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(transportSignal).toBeDefined()
		expect(transportSignal).not.toBe(caller.signal)
		expect(transportSignal?.aborted).toBe(true)
		expect(transportSignal?.reason).toBe(reason)
	})
})
