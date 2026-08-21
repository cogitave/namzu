import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MCPConnectorBridge } from '../../../bridge/mcp/connector/adapter.js'
import { BaseConnector } from '../../../connector/BaseConnector.js'
import {
	connectorInstanceToTools,
	createConnectorRouterTool,
} from '../../../connector/tools/adapter.js'
import { ConnectorRegistry } from '../../../registry/connector/definitions.js'
import type {
	ConnectionType,
	ConnectorDefinition,
	ConnectorExecuteResult,
	ConnectorInstance,
	ConnectorLifecycleEvent,
	ConnectorMethod,
	ConnectorOperationOptions,
} from '../../../types/connector/index.js'
import type { ConnectorId } from '../../../types/ids/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { asConnectorId } from '../../../utils/id.js'
import { ConnectorManager } from '../lifecycle.js'

const CONNECTOR_ID = asConnectorId('conn_method_contract')
const OTHER_ID = asConnectorId('conn_mutated_projection')

class ContractConnector extends BaseConnector<Record<string, never>> {
	readonly id = CONNECTOR_ID
	readonly name = 'Method contract'
	readonly description = 'Exercises the registered method boundary'
	readonly connectionType: ConnectionType = 'custom'
	readonly configSchema = z.object({})
	readonly methods: ConnectorMethod[]
	readonly calls: Array<{ method: string; input: unknown; options?: ConnectorOperationOptions }> =
		[]
	result: ConnectorExecuteResult

	constructor(methods: ConnectorMethod[], result: ConnectorExecuteResult) {
		super()
		this.methods = methods
		this.result = result
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
		this.calls.push({ method, input, options })
		return this.result
	}
}

async function connected(
	methods: ConnectorMethod[],
	result: ConnectorExecuteResult,
): Promise<{
	registry: ConnectorRegistry
	manager: ConnectorManager
	connector: ContractConnector
	instance: ConnectorInstance
}> {
	const registry = new ConnectorRegistry()
	const connector = new ContractConnector(methods, result)
	registry.register(connector.toDefinition())
	const manager = new ConnectorManager({ registry })
	const instance = await manager.createInstance(
		{ connectorId: connector.id, name: 'contract', options: {} },
		connector,
	)
	await manager.connect(instance.id)
	return { registry, manager, connector, instance }
}

describe('ConnectorManager method contracts', () => {
	it('refuses hidden methods and malformed input before connector I/O or lifecycle publication', async () => {
		const methods: ConnectorMethod[] = [
			{
				name: 'safe',
				description: 'safe method',
				inputSchema: z.object({ required: z.string() }),
			},
		]
		const { manager, connector, instance } = await connected(methods, {
			success: true,
			output: 'should not run',
			durationMs: 1,
		})
		const events: ConnectorLifecycleEvent[] = []
		manager.on((event) => events.push(event))

		const hidden = await manager.execute({
			instanceId: instance.id,
			method: 'hidden_delete',
			input: { required: 'valid for the advertised method' },
		})
		const malformed = await manager.execute({
			instanceId: instance.id,
			method: 'safe',
			input: { required: 42 },
		})

		expect(connector.calls).toEqual([])
		expect(events).toEqual([])
		for (const refusal of [hidden, malformed]) {
			expect(refusal).toMatchObject({
				success: false,
				output: null,
				metadata: { remoteOutcome: 'not_started', retrySafety: 'safe' },
			})
			expect(refusal.error).toContain('No remote request was started')
		}
	})

	it('withdraws authority while async input parsing is held without late connector publication', async () => {
		let markEntered: (() => void) | undefined
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve
		})
		let releaseValidation: (() => void) | undefined
		const validationGate = new Promise<void>((resolve) => {
			releaseValidation = resolve
		})
		const methods: ConnectorMethod[] = [
			{
				name: 'held',
				description: 'held input validation',
				inputSchema: z.object({ value: z.string() }).transform(async (value) => {
					markEntered?.()
					await validationGate
					return value
				}),
			},
		]
		const { manager, connector, instance } = await connected(methods, {
			success: true,
			output: 'late',
			durationMs: 1,
		})
		const events: ConnectorLifecycleEvent[] = []
		manager.on((event) => events.push(event))
		const caller = new AbortController()
		const pending = manager.execute({
			instanceId: instance.id,
			method: 'held',
			input: { value: 'x' },
			signal: caller.signal,
		})

		await Promise.race([
			entered,
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error('input validation never started')), 250)
			}),
		])
		caller.abort(new Error('input authority withdrawn'))
		const result = await pending

		expect(result).toMatchObject({
			success: false,
			metadata: { remoteOutcome: 'not_started', retrySafety: 'safe' },
		})
		expect(result.error).toContain('cancelled during input validation')
		expect(connector.calls).toEqual([])
		expect(events).toEqual([])
		releaseValidation?.()
		await validationGate
		await Promise.resolve()
		expect(connector.calls).toEqual([])
		expect(events).toEqual([])
	})

	it('parses async input once and publishes the async output schema canonical value', async () => {
		let inputTransforms = 0
		let outputTransforms = 0
		const methods: ConnectorMethod[] = [
			{
				name: 'canonicalize',
				description: 'canonicalize a value',
				inputSchema: z.object({ raw: z.string() }).transform(async ({ raw }) => {
					inputTransforms++
					await Promise.resolve()
					return { canonical: raw.trim() }
				}),
				outputSchema: z.object({ raw: z.string() }).transform(async ({ raw }) => {
					outputTransforms++
					await Promise.resolve()
					return { accepted: raw.toUpperCase() }
				}),
			},
		]
		const { manager, connector, instance } = await connected(methods, {
			success: true,
			output: { raw: 'yes' },
			durationMs: 3,
		})

		const result = await manager.execute({
			instanceId: instance.id,
			method: 'canonicalize',
			input: { raw: ' value ' },
		})

		expect(inputTransforms).toBe(1)
		expect(outputTransforms).toBe(1)
		expect(connector.calls).toHaveLength(1)
		expect(instance.lastUsedAt).toEqual(expect.any(Number))
		expect(connector.calls[0]?.input).toEqual({ canonical: 'value' })
		expect(result).toMatchObject({ success: true, output: { accepted: 'YES' } })
	})

	it('withdraws authority while async output validation is held without late publication', async () => {
		let markEntered: (() => void) | undefined
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve
		})
		let releaseValidation: (() => void) | undefined
		const validationGate = new Promise<void>((resolve) => {
			releaseValidation = resolve
		})
		const methods: ConnectorMethod[] = [
			{
				name: 'held_output',
				description: 'held output validation',
				inputSchema: z.object({}),
				outputSchema: z.unknown().transform(async (value) => {
					markEntered?.()
					await validationGate
					return value
				}),
			},
		]
		const { manager, connector, instance } = await connected(methods, {
			success: true,
			output: { accepted: true },
			durationMs: 3,
		})
		const completed: boolean[] = []
		manager.on((event) => {
			if (event.type === 'action_completed') completed.push(event.success)
		})
		const caller = new AbortController()
		const pending = manager.execute({
			instanceId: instance.id,
			method: 'held_output',
			input: {},
			signal: caller.signal,
		})

		await Promise.race([
			entered,
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error('output validation never started')), 250)
			}),
		])
		caller.abort(new Error('output authority withdrawn'))
		const result = await Promise.race([
			pending,
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error('output validation ignored cancellation')), 250)
			}),
		])

		expect(connector.calls).toHaveLength(1)
		expect(result).toMatchObject({
			success: false,
			output: null,
			metadata: { remoteOutcome: 'response_received', retrySafety: 'unsafe' },
		})
		expect(completed).toEqual([false])
		releaseValidation?.()
		await validationGate
		await Promise.resolve()
		expect(completed).toEqual([false])
	})

	it('quarantines an invalid successful output and completes the real action as failed', async () => {
		const leaked = 'invalid-output-must-not-reach-the-model'
		const methods: ConnectorMethod[] = [
			{
				name: 'write',
				description: 'write remotely',
				inputSchema: z.object({}),
				outputSchema: z.unknown().superRefine((value, context) => {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `hostile validator echoed ${JSON.stringify(value)}`,
					})
				}),
			},
		]
		const { manager, connector, instance } = await connected(methods, {
			success: true,
			output: { secret: leaked },
			durationMs: 7,
			metadata: { requestId: 'req_1', retrySafety: 'safe' },
		})
		const events: ConnectorLifecycleEvent[] = []
		manager.on((event) => events.push(event))

		const result = await manager.execute({
			instanceId: instance.id,
			method: 'write',
			input: {},
		})

		expect(connector.calls).toHaveLength(1)
		expect(result).toMatchObject({
			success: false,
			output: null,
			metadata: {
				requestId: 'req_1',
				remoteOutcome: 'response_received',
				retrySafety: 'unsafe',
			},
		})
		expect(JSON.stringify(result)).not.toContain(leaked)
		expect(events).toEqual([
			{ type: 'action_executing', instanceId: instance.id, method: 'write' },
			{
				type: 'action_completed',
				instanceId: instance.id,
				method: 'write',
				success: false,
				durationMs: 7,
			},
		])

		const bridge = new MCPConnectorBridge({ manager })
		bridge.listTools(instance.id)
		const bridged = await bridge.callTool(`namzu_${CONNECTOR_ID}_write`)
		expect(bridged.isError).toBe(true)
		expect(JSON.stringify(bridged)).toContain('violates its registered schema')
		expect(JSON.stringify(bridged)).not.toContain(leaked)
	})

	it('does not expose a raw body echoed by an output validator exception', async () => {
		const leaked = 'throwing-validator-must-not-leak-this-body'
		const methods: ConnectorMethod[] = [
			{
				name: 'throwing_output',
				description: 'throws while validating output',
				inputSchema: z.object({}),
				outputSchema: z.unknown().transform(async (value) => {
					throw new Error(`validator echoed ${JSON.stringify(value)}`)
				}),
			},
		]
		const { manager, connector, instance } = await connected(methods, {
			success: true,
			output: { raw: leaked },
			durationMs: 4,
		})

		const result = await manager.execute({
			instanceId: instance.id,
			method: 'throwing_output',
			input: {},
		})

		expect(connector.calls).toHaveLength(1)
		expect(result).toMatchObject({
			success: false,
			output: null,
			metadata: { remoteOutcome: 'response_received', retrySafety: 'unsafe' },
		})
		expect(result.error).toContain('could not establish the registered contract')
		expect(JSON.stringify(result)).not.toContain(leaked)
	})

	it('uses a detached admission snapshot for tool, router and MCP projections', async () => {
		const methods: ConnectorMethod[] = [
			{
				name: 'stable',
				description: 'stable method',
				inputSchema: z.object({ raw: z.string() }),
				outputSchema: z.object({ accepted: z.string() }),
			},
		]
		const { registry, manager, instance } = await connected(methods, {
			success: true,
			output: { accepted: 'yes' },
			durationMs: 1,
		})
		const exposed = manager.getInstanceDefinition(instance.id)
		exposed.methods[0]!.name = 'mutated_copy'
		exposed.methods.length = 0
		methods[0]!.name = 'mutated_source'
		;(instance as { connectorId: ConnectorId }).connectorId = OTHER_ID
		registry.register({
			...methodsDefinition('replacement_only'),
			id: CONNECTOR_ID,
		})

		const tools = connectorInstanceToTools(instance.id, manager)
		const router = createConnectorRouterTool(manager)
		const bridge = new MCPConnectorBridge({ manager })
		const mcpTools = bridge.listTools(instance.id)
		const routed = await router.execute(
			{
				connectorId: CONNECTOR_ID,
				instanceId: instance.id,
				method: 'stable',
				input: { raw: 'still admitted' },
			},
			{} as ToolContext,
		)

		expect(routed.success).toBe(true)
		expect(tools.map((tool) => tool.name)).toEqual([`${CONNECTOR_ID}_stable`])
		expect(tools[0]?.modelInputSchema).toMatchObject({
			type: 'object',
			properties: { raw: { type: 'string' } },
		})
		expect(tools[0]?.outputSchema).toMatchObject({
			type: 'object',
			properties: { accepted: { type: 'string' } },
		})
		expect(router.description).toContain(`${CONNECTOR_ID} (${instance.id}): stable`)
		expect(router.description).not.toContain('replacement_only')
		expect(mcpTools).toMatchObject([
			{
				name: `namzu_${CONNECTOR_ID}_stable`,
				inputSchema: { type: 'object', properties: { raw: { type: 'string' } } },
				outputSchema: {
					type: 'object',
					properties: { accepted: { type: 'string' } },
				},
			},
		])
		expect(manager.getInstanceDefinition(instance.id).methods[0]?.name).toBe('stable')
	})

	it('refuses an implementation whose method surface differs or contains duplicates', async () => {
		const registry = new ConnectorRegistry()
		const registeredMethod: ConnectorMethod = {
			name: 'registered',
			description: 'registered',
			inputSchema: z.object({}),
		}
		registry.register(methodsDefinition('registered'))
		const manager = new ConnectorManager({ registry })
		const mismatched = new ContractConnector([{ ...registeredMethod, name: 'hidden' }], {
			success: true,
			output: null,
			durationMs: 1,
		})
		await expect(
			manager.createInstance(
				{ connectorId: CONNECTOR_ID, name: 'mismatch', options: {} },
				mismatched,
			),
		).rejects.toThrow(/method surface/)

		const duplicateDefinition = methodsDefinition('registered')
		duplicateDefinition.methods.push({ ...registeredMethod })
		registry.register(duplicateDefinition)
		const duplicate = new ContractConnector([{ ...registeredMethod }, { ...registeredMethod }], {
			success: true,
			output: null,
			durationMs: 1,
		})
		await expect(
			manager.createInstance(
				{ connectorId: CONNECTOR_ID, name: 'duplicate', options: {} },
				duplicate,
			),
		).rejects.toThrow(/method surface/)
	})

	it('refuses an unprojectable method schema before publishing an instance', async () => {
		const invalidMethod = {
			name: 'invalid_schema',
			description: 'invalid schema',
			inputSchema: null as unknown as z.ZodType,
		}
		const connector = new ContractConnector([invalidMethod], {
			success: true,
			output: null,
			durationMs: 1,
		})
		const registry = new ConnectorRegistry()
		registry.register(connector.toDefinition())
		const manager = new ConnectorManager({ registry })

		await expect(
			manager.createInstance(
				{ connectorId: CONNECTOR_ID, name: 'invalid schema', options: {} },
				connector,
			),
		).rejects.toThrow(/cannot be projected/)
		expect(manager.listInstances()).toEqual([])
	})
})

function methodsDefinition(methodName: string): ConnectorDefinition {
	return {
		id: CONNECTOR_ID,
		name: 'Method contract',
		description: 'method contract',
		connectionType: 'custom',
		configSchema: z.object({}),
		methods: [
			{
				name: methodName,
				description: methodName,
				inputSchema: z.object({}),
			},
		],
	}
}
