import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { BaseConnector } from '../../../connector/BaseConnector.js'
import { ConnectorRegistry } from '../../../registry/connector/definitions.js'
import { ScopedConnectorRegistry } from '../../../registry/connector/scoped.js'
import type {
	ConnectionType,
	ConnectorExecuteResult,
	ConnectorMethod,
	ConnectorOperationOptions,
} from '../../../types/connector/index.js'
import type { ConnectorInstanceId, EnvironmentId, TenantId } from '../../../types/ids/index.js'
import { asConnectorId } from '../../../utils/id.js'
import { EnvironmentConnectorManager } from '../environment.js'
import { ConnectorManager } from '../lifecycle.js'
import { TenantConnectorManager } from '../tenant.js'

class HeldConnector extends BaseConnector<Record<string, never>> {
	readonly id = asConnectorId('conn_held_operation')
	readonly name = 'Held connector'
	readonly description = 'test connector'
	readonly connectionType: ConnectionType = 'custom'
	readonly configSchema = z.object({})
	readonly methods: ConnectorMethod[] = [
		{ name: 'hold', description: 'hold forever', inputSchema: z.object({}) },
	]
	executeCalls = 0
	healthCalls = 0
	receivedSignal: AbortSignal | undefined
	onExecute: (() => void) | undefined
	succeedOnAbort = false

	async connect(): Promise<void> {}
	async disconnect(): Promise<void> {}

	async healthCheck(options?: ConnectorOperationOptions): Promise<boolean> {
		this.healthCalls++
		this.receivedSignal = options?.signal
		return new Promise<boolean>((resolve) => {
			setTimeout(() => resolve(true), 25)
		})
	}

	async execute(
		_method: string,
		_input: unknown,
		options?: ConnectorOperationOptions,
	): Promise<ConnectorExecuteResult> {
		this.executeCalls++
		this.receivedSignal = options?.signal
		this.onExecute?.()
		if (this.succeedOnAbort && options?.signal) {
			return new Promise<ConnectorExecuteResult>((resolve) => {
				options.signal?.addEventListener(
					'abort',
					() =>
						resolve({
							success: true,
							output: 'late side effect',
							durationMs: 1,
						}),
					{ once: true },
				)
			})
		}
		return new Promise<ConnectorExecuteResult>((resolve) => {
			setTimeout(
				() => resolve({ success: true, output: 'late unphased success', durationMs: 25 }),
				25,
			)
		})
	}
}

async function connected(): Promise<{
	manager: ConnectorManager
	connector: HeldConnector
	id: ConnectorInstanceId
}> {
	const registry = new ConnectorRegistry()
	const connector = new HeldConnector()
	registry.register(connector.toDefinition())
	const manager = new ConnectorManager({ registry })
	const instance = await manager.createInstance(
		{ connectorId: connector.id, name: 'held', options: {} },
		connector,
	)
	await manager.connect(instance.id)
	return { manager, connector, id: instance.id }
}

describe('ConnectorManager operation authority', () => {
	it('refuses a pre-aborted execution before invoking the connector', async () => {
		const { manager, connector, id } = await connected()
		const result = await manager.execute({
			instanceId: id,
			method: 'hold',
			input: {},
			signal: AbortSignal.abort(new Error('stopped before admission')),
		})

		expect(connector.executeCalls).toBe(0)
		expect(result.metadata).toMatchObject({ remoteOutcome: 'not_started', retrySafety: 'safe' })
	})

	it('abandons an uncooperative custom connector with an honest unknown outcome', async () => {
		const { manager, connector, id } = await connected()
		const caller = new AbortController()
		const pending = manager.execute({
			instanceId: id,
			method: 'hold',
			input: {},
			signal: caller.signal,
		})
		const reason = new Error('operator stopped the connector')
		caller.abort(reason)

		const result = await pending

		expect(connector.executeCalls).toBe(1)
		expect(connector.receivedSignal).toBe(caller.signal)
		expect(result.metadata).toMatchObject({ remoteOutcome: 'unknown', retrySafety: 'unknown' })
		expect(result.error).toContain('do not automatically retry')
	})

	it('observes cancellation that happens synchronously while connector execution starts', async () => {
		vi.useFakeTimers()
		try {
			const { manager, connector, id } = await connected()
			const caller = new AbortController()
			const completed: boolean[] = []
			manager.on((event) => {
				if (event.type === 'action_completed') completed.push(event.success)
			})
			connector.onExecute = () => caller.abort(new Error('cancelled inside execute'))

			const pending = manager.execute({
				instanceId: id,
				method: 'hold',
				input: {},
				signal: caller.signal,
			})
			await vi.advanceTimersByTimeAsync(0)

			expect(completed).toEqual([false])
			const result = await pending
			expect(connector.executeCalls).toBe(1)
			expect(result.metadata).toMatchObject({
				remoteOutcome: 'unknown',
				retrySafety: 'unknown',
			})
		} finally {
			vi.useRealTimers()
		}
	})

	it('refuses an unphased success resolved by the connector abort listener', async () => {
		const { manager, connector, id } = await connected()
		connector.succeedOnAbort = true
		const completed: boolean[] = []
		manager.on((event) => {
			if (event.type === 'action_completed') completed.push(event.success)
		})
		const caller = new AbortController()
		const pending = manager.execute({
			instanceId: id,
			method: 'hold',
			input: {},
			signal: caller.signal,
		})
		caller.abort(new Error('authority withdrawn before late success'))

		const result = await pending

		expect(result.success).toBe(false)
		expect(result.output).toBeNull()
		expect(result.metadata).toMatchObject({ remoteOutcome: 'unknown', retrySafety: 'unknown' })
		expect(completed).toEqual([false])
	})

	it('bounds a custom health check with the same caller signal', async () => {
		const { manager, connector, id } = await connected()
		const caller = new AbortController()
		const pending = manager.healthCheck(id, { signal: caller.signal })
		caller.abort(new Error('stop health check'))

		expect(await pending).toBe(false)
		expect(connector.healthCalls).toBe(1)
		expect(connector.receivedSignal).toBe(caller.signal)
	})

	it('does not spend a tenant rate-limit slot for a pre-aborted operation', async () => {
		const registry = new ConnectorRegistry()
		const connector = new HeldConnector()
		registry.register(connector.toDefinition())
		const manager = new TenantConnectorManager({
			registry,
			defaultRateLimit: { maxRequests: 1, windowMs: 60_000 },
		})
		const tenantId = 'tnt_connector_authority' as TenantId
		manager.registerTenant({ id: tenantId, name: 'Connector authority' })
		const instance = await manager.createInstance(
			tenantId,
			{ connectorId: connector.id, name: 'tenant held', options: {} },
			connector,
		)
		await manager.connect(tenantId, instance.id)

		const refused = await manager.execute(tenantId, {
			instanceId: instance.id,
			method: 'hold',
			input: {},
			signal: AbortSignal.abort(new Error('cancelled before tenant admission')),
		})
		expect(refused.metadata).toMatchObject({ remoteOutcome: 'not_started', retrySafety: 'safe' })

		const caller = new AbortController()
		const live = manager.execute(tenantId, {
			instanceId: instance.id,
			method: 'hold',
			input: {},
			signal: caller.signal,
		})
		caller.abort(new Error('settle admitted operation'))
		const admitted = await live

		expect(admitted.error).not.toMatch(/rate limit exceeded/i)
		expect(connector.executeCalls).toBe(1)
		expect(connector.receivedSignal).toBe(caller.signal)
	})

	it('forwards health cancellation through tenant and environment manager surfaces', async () => {
		const registry = new ConnectorRegistry()
		const tenantConnector = new HeldConnector()
		registry.register(tenantConnector.toDefinition())

		const tenantManager = new TenantConnectorManager({ registry })
		const tenantId = 'tnt_connector_health' as TenantId
		tenantManager.registerTenant({ id: tenantId, name: 'Health tenant' })
		const tenantInstance = await tenantManager.createInstance(
			tenantId,
			{ connectorId: tenantConnector.id, name: 'tenant health', options: {} },
			tenantConnector,
		)
		await tenantManager.connect(tenantId, tenantInstance.id)
		const tenantCaller = new AbortController()
		const tenantHealth = tenantManager.healthCheck(tenantId, tenantInstance.id, {
			signal: tenantCaller.signal,
		})
		tenantCaller.abort(new Error('stop tenant health'))
		expect(await tenantHealth).toBe(false)
		expect(tenantConnector.receivedSignal).toBe(tenantCaller.signal)

		const environmentConnector = new HeldConnector()
		const scopedRegistry = new ScopedConnectorRegistry()
		scopedRegistry.set({
			scope: { scope: 'environment', scopeId: 'env_connector_health' },
			connectorId: environmentConnector.id,
			options: {},
		})
		const environmentManager = new EnvironmentConnectorManager({
			connectorRegistry: registry,
			scopedRegistry,
		})
		const environmentId = 'env_connector_health' as EnvironmentId
		environmentManager.registerEnvironment({
			environment: { id: environmentId, name: 'Health environment', tier: 'testing' },
			scopeChain: { environment: environmentId },
		})
		const environmentInstance = await environmentManager.createConnectorFromScope(
			environmentId,
			environmentConnector.id,
			environmentConnector,
		)
		await environmentManager.connect(environmentId, environmentInstance.id)
		const environmentCaller = new AbortController()
		const environmentHealth = environmentManager.healthCheck(
			environmentId,
			environmentInstance.id,
			{ signal: environmentCaller.signal },
		)
		environmentCaller.abort(new Error('stop environment health'))
		expect(await environmentHealth).toBe(false)
		expect(environmentConnector.receivedSignal).toBe(environmentCaller.signal)

		const executeCaller = new AbortController()
		const environmentExecution = environmentManager.execute(environmentId, {
			instanceId: environmentInstance.id,
			method: 'hold',
			input: {},
			signal: executeCaller.signal,
		})
		executeCaller.abort(new Error('stop environment execution'))
		const environmentResult = await environmentExecution
		expect(environmentResult.metadata).toMatchObject({
			remoteOutcome: 'unknown',
			retrySafety: 'unknown',
		})
		expect(environmentConnector.receivedSignal).toBe(executeCaller.signal)
	})
})
