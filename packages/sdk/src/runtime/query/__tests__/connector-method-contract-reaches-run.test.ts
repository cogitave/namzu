import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { BaseConnector } from '../../../connector/BaseConnector.js'
import { ConnectorToolRouter } from '../../../connector/tools/router.js'
import { ConnectorManager } from '../../../manager/connector/lifecycle.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ConnectorRegistry } from '../../../registry/connector/definitions.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type {
	ConnectionType,
	ConnectorExecuteResult,
	ConnectorMethod,
	ConnectorOperationOptions,
} from '../../../types/connector/index.js'
import type { ProjectId, SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { TopicId } from '../../../types/session/ids.js'
import { asConnectorId } from '../../../utils/id.js'
import { drainQuery } from '../index.js'

const CONNECTOR_ID = asConnectorId('conn_query_contract')

class QueryContractConnector extends BaseConnector<Record<string, never>> {
	readonly id = CONNECTOR_ID
	readonly name = 'Query contract connector'
	readonly description = 'query reachability fixture'
	readonly connectionType: ConnectionType = 'custom'
	readonly configSchema = z.object({})
	readonly methods: ConnectorMethod[]
	readonly calls: Array<{ method: string; input: unknown }> = []
	private readonly outputForInput: (input: unknown) => unknown

	constructor(
		methods: ConnectorMethod[],
		outputForInput: (input: unknown) => unknown = (input) => ({ accepted: input }),
	) {
		super()
		this.methods = methods
		this.outputForInput = outputForInput
	}

	async connect(): Promise<void> {}
	async disconnect(): Promise<void> {}
	async healthCheck(): Promise<boolean> {
		return true
	}

	async execute(
		method: string,
		input: unknown,
		options?: ConnectorOperationOptions,
	): Promise<ConnectorExecuteResult> {
		const canonical = await this.validateInput(this.requireMethod(method), input, options)
		this.calls.push({ method, input: canonical })
		return {
			success: true,
			output: this.outputForInput(canonical),
			durationMs: 2,
		}
	}
}

describe('connector method contracts reach a real query', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	it('parses an async per-method transform exactly once at the manager boundary', async () => {
		let transforms = 0
		const method: ConnectorMethod = {
			name: 'canonicalize',
			description: 'canonicalize raw text',
			inputSchema: z.object({ raw: z.string() }).transform(async ({ raw }) => {
				transforms++
				await Promise.resolve()
				return { canonical: raw.trim() }
			}),
			outputSchema: z.object({ accepted: z.object({ canonical: z.string() }) }),
		}
		const { connector, manager, instance } = await connected([method])
		const tools = new ToolRegistry()
		const router = new ConnectorToolRouter({ manager })
		const registered = router.registerTools(tools)
		expect(registered).toEqual([`${CONNECTOR_ID}_canonicalize`])

		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{
							id: 'call_canonicalize',
							name: `${CONNECTOR_ID}_canonicalize`,
							args: { raw: ' value ' },
						},
					],
					finishReason: 'tool_calls',
				},
				{ text: 'connector result accepted' },
			],
		})
		const completed = await runConnectorQuery(provider, tools)

		expect(completed.status).toBe('completed')
		expect(transforms).toBe(1)
		expect(connector.calls).toEqual([{ method: 'canonicalize', input: { canonical: 'value' } }])
		expect(provider.requests).toHaveLength(2)
		const advertised = provider.requests[0]?.tools?.find(
			(tool) => tool.function.name === `${CONNECTOR_ID}_canonicalize`,
		)
		expect(advertised?.function.parameters).toMatchObject({
			type: 'object',
			properties: { raw: { type: 'string' } },
			required: ['raw'],
		})
		expect(advertised?.function.description).toContain('"accepted"')
		const continuation = JSON.stringify(provider.requests[1]?.messages)
		expect(continuation).toContain('canonical')
		expect(continuation).toContain('value')
		expect(manager.getInstanceConnectorId(instance.id)).toBe(CONNECTOR_ID)
	})

	it('returns hidden-method and malformed-input refusals to the model without connector I/O', async () => {
		const method: ConnectorMethod = {
			name: 'safe',
			description: 'only registered method',
			inputSchema: z.object({ required: z.string() }),
		}
		const { connector, manager, instance } = await connected([method])
		const tools = new ToolRegistry()
		new ConnectorToolRouter({ manager, strategy: 'router' }).registerTools(tools)
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{
							id: 'call_hidden',
							name: 'connector_execute',
							args: {
								connectorId: CONNECTOR_ID,
								instanceId: instance.id,
								method: 'hidden_delete',
								input: {},
							},
						},
						{
							id: 'call_malformed',
							name: 'connector_execute',
							args: {
								connectorId: CONNECTOR_ID,
								instanceId: instance.id,
								method: 'safe',
								input: { required: 42 },
							},
						},
					],
					finishReason: 'tool_calls',
				},
				{ text: 'I received both refusals' },
			],
		})

		const completed = await runConnectorQuery(provider, tools)

		expect(completed.status).toBe('completed')
		expect(connector.calls).toEqual([])
		expect(provider.requests).toHaveLength(2)
		const continuation = JSON.stringify(provider.requests[1]?.messages)
		expect(continuation).toContain('not registered')
		expect(continuation).toContain('Invalid input')
		expect(continuation).toContain('No remote request was started')
	})

	it('keeps an invalid successful connector body out of the next model request', async () => {
		const leaked = 'raw-invalid-connector-body'
		const method: ConnectorMethod = {
			name: 'write',
			description: 'write and return a receipt',
			inputSchema: z.object({ value: z.string() }),
			outputSchema: z.unknown().superRefine((value, context) => {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `hostile validator echoed ${JSON.stringify(value)}`,
				})
			}),
		}
		const { connector, manager } = await connected([method], () => ({ raw: leaked }))
		const tools = new ToolRegistry()
		new ConnectorToolRouter({ manager }).registerTools(tools)
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{
							id: 'call_invalid_output',
							name: `${CONNECTOR_ID}_write`,
							args: { value: 'publish' },
						},
					],
					finishReason: 'tool_calls',
				},
				{ text: 'I received the schema refusal' },
			],
		})

		const completed = await runConnectorQuery(provider, tools)

		expect(completed.status).toBe('completed')
		expect(connector.calls).toHaveLength(1)
		const continuation = JSON.stringify(provider.requests[1]?.messages)
		expect(continuation).toContain('violates its registered schema')
		expect(continuation).toContain('do not automatically retry')
		expect(continuation).not.toContain(leaked)
	})

	async function connected(
		methods: ConnectorMethod[],
		outputForInput?: (input: unknown) => unknown,
	): Promise<{
		connector: QueryContractConnector
		manager: ConnectorManager
		instance: Awaited<ReturnType<ConnectorManager['createInstance']>>
	}> {
		const connector = new QueryContractConnector(methods, outputForInput)
		const registry = new ConnectorRegistry()
		registry.register(connector.toDefinition())
		const manager = new ConnectorManager({ registry })
		const instance = await manager.createInstance(
			{ connectorId: connector.id, name: 'query contract', options: {} },
			connector,
		)
		await manager.connect(instance.id)
		return { connector, manager, instance }
	}

	async function runConnectorQuery(provider: MockLLMProvider, tools: ToolRegistry) {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-connector-contract-'))
		workdirs.push(workingDirectory)
		return drainQuery({
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
			agentId: 'agent_connector_contract',
			agentName: 'Connector Contract',
			messages: [createUserMessage('use the connector')],
			workingDirectory,
			sessionId: 'ses_connector_contract' as SessionId,
			topicId: 'top_connector_contract' as TopicId,
			projectId: 'prj_connector_contract' as ProjectId,
			tenantId: 'tnt_connector_contract' as TenantId,
		})
	}
})
