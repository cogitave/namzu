import type { BaseConnector } from '../../connector/BaseConnector.js'
import type { ConnectorRegistry } from '../../registry/connector/definitions.js'
import type {
	ConnectorConfig,
	ConnectorEventListener,
	ConnectorExecuteParams,
	ConnectorExecuteResult,
	ConnectorInstance,
	ConnectorLifecycleEvent,
	ConnectorStatus,
} from '../../types/connector/index.js'
import type { ConnectorId, ConnectorInstanceId } from '../../types/ids/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { generateConnectorInstanceId } from '../../utils/id.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'

export interface ConnectorManagerConfig {
	registry: ConnectorRegistry
}

export class ConnectorManager {
	private registry: ConnectorRegistry
	private instances: Map<ConnectorInstanceId, ConnectorInstance> = new Map()
	private liveConnectors: Map<ConnectorInstanceId, BaseConnector<unknown>> = new Map()
	private listeners: ConnectorEventListener[] = []
	private log: Logger

	constructor(config: ConnectorManagerConfig) {
		this.registry = config.registry
		this.log = getRootLogger().child({ component: 'ConnectorManager' })
	}

	on(listener: ConnectorEventListener): void {
		this.listeners.push(listener)
	}

	off(listener: ConnectorEventListener): void {
		const index = this.listeners.indexOf(listener)
		if (index >= 0) this.listeners.splice(index, 1)
	}

	async createInstance(
		config: ConnectorConfig,
		connector: BaseConnector<unknown>,
	): Promise<ConnectorInstance> {
		const definition = this.registry.getOrThrow(config.connectorId)

		const parsedConfig = definition.configSchema.safeParse(config.options ?? {})
		if (!parsedConfig.success) {
			const errors = parsedConfig.error.issues
				.map((i) => `${i.path.join('.')}: ${i.message}`)
				.join('; ')
			throw new Error(`Invalid config for connector "${config.connectorId}": ${errors}`)
		}

		const instanceId = generateConnectorInstanceId()
		const instance: ConnectorInstance = {
			id: instanceId,
			connectorId: config.connectorId,
			config,
			status: 'disconnected',
			createdAt: Date.now(),
		}

		this.instances.set(instanceId, instance)
		this.liveConnectors.set(instanceId, connector)
		this.emit({ type: 'instance_created', instanceId, connectorId: config.connectorId })
		this.log.info(`Connector instance created: ${instanceId} (${config.connectorId})`)

		return instance
	}

	async connect(instanceId: ConnectorInstanceId): Promise<void> {
		const instance = this.getInstanceOrThrow(instanceId)
		const connector = this.getConnectorOrThrow(instanceId)

		this.updateStatus(instanceId, 'connecting')
		this.emit({ type: 'instance_connecting', instanceId })

		try {
			const definition = this.registry.getOrThrow(instance.connectorId)
			const parsedConfig = definition.configSchema.parse(instance.config.options ?? {})
			await connector.connect(parsedConfig, instance.config.auth)
			this.updateStatus(instanceId, 'connected')
			instance.connectedAt = Date.now()
			this.emit({ type: 'instance_connected', instanceId })
			this.log.info(`Connector connected: ${instanceId}`)
		} catch (err) {
			const message = toErrorMessage(err)
			this.updateStatus(instanceId, 'error', message)
			this.emit({ type: 'instance_error', instanceId, error: message })
			this.log.error(`Connector connection failed: ${instanceId}`, { error: message })
			throw err
		}
	}

	async disconnect(instanceId: ConnectorInstanceId): Promise<void> {
		const connector = this.getConnectorOrThrow(instanceId)

		try {
			await connector.disconnect()
			this.updateStatus(instanceId, 'disconnected')
			this.emit({ type: 'instance_disconnected', instanceId })
			this.log.info(`Connector disconnected: ${instanceId}`)
		} catch (err) {
			const message = toErrorMessage(err)
			this.log.error(`Connector disconnect failed: ${instanceId}`, { error: message })
			throw err
		}
	}

	async healthCheck(instanceId: ConnectorInstanceId): Promise<boolean> {
		const connector = this.getConnectorOrThrow(instanceId)
		try {
			return await connector.healthCheck()
		} catch {
			return false
		}
	}

	async execute(params: ConnectorExecuteParams): Promise<ConnectorExecuteResult> {
		const instance = this.getInstanceOrThrow(params.instanceId)
		const connector = this.getConnectorOrThrow(params.instanceId)

		if (instance.status !== 'connected') {
			return {
				success: false,
				output: null,
				error: `Connector "${params.instanceId}" is not connected (status: ${instance.status})`,
				durationMs: 0,
			}
		}

		this.emit({ type: 'action_executing', instanceId: params.instanceId, method: params.method })
		const start = performance.now()
		try {
			const result = await connector.execute(params.method, params.input)
			instance.lastUsedAt = Date.now()
			this.emit({
				type: 'action_completed',
				instanceId: params.instanceId,
				method: params.method,
				success: result.success,
				durationMs: result.durationMs,
			})
			return result
		} catch (err) {
			const message = toErrorMessage(err)
			const durationMs = Math.round(performance.now() - start)
			this.emit({
				type: 'action_completed',
				instanceId: params.instanceId,
				method: params.method,
				success: false,
				durationMs,
			})
			return {
				success: false,
				output: null,
				error: `Execution failed: ${message}`,
				durationMs,
			}
		}
	}

	async removeInstance(instanceId: ConnectorInstanceId): Promise<void> {
		const instance = this.instances.get(instanceId)
		if (!instance) return

		if (instance.status === 'connected') {
			await this.disconnect(instanceId).catch((err) => {
				this.log.warn('Disconnect failed during removal', {
					instanceId,
					error: toErrorMessage(err),
				})
			})
		}

		this.instances.delete(instanceId)
		this.liveConnectors.delete(instanceId)
		this.emit({ type: 'instance_removed', instanceId })
		this.log.info(`Connector instance removed: ${instanceId}`)
	}

	getRegistry(): ConnectorRegistry {
		return this.registry
	}

	getInstance(instanceId: ConnectorInstanceId): ConnectorInstance | undefined {
		return this.instances.get(instanceId)
	}

	getConnector(instanceId: ConnectorInstanceId): BaseConnector<unknown> | undefined {
		return this.liveConnectors.get(instanceId)
	}

	listInstances(): ConnectorInstance[] {
		return Array.from(this.instances.values())
	}

	listInstancesByConnector(connectorId: ConnectorId): ConnectorInstance[] {
		return this.listInstances().filter((i) => i.connectorId === connectorId)
	}

	listConnectedInstances(): ConnectorInstance[] {
		return this.listInstances().filter((i) => i.status === 'connected')
	}

	async disconnectAll(): Promise<void> {
		const connected = this.listInstances().filter((i) => i.status === 'connected')
		await Promise.allSettled(connected.map((i) => this.disconnect(i.id)))
	}

	private getInstanceOrThrow(instanceId: ConnectorInstanceId): ConnectorInstance {
		const instance = this.instances.get(instanceId)
		if (!instance) {
			throw new Error(`Connector instance not found: "${instanceId}"`)
		}
		return instance
	}

	private getConnectorOrThrow(instanceId: ConnectorInstanceId): BaseConnector<unknown> {
		const connector = this.liveConnectors.get(instanceId)
		if (!connector) {
			throw new Error(`Live connector not found for instance: "${instanceId}"`)
		}
		return connector
	}

	private updateStatus(
		instanceId: ConnectorInstanceId,
		status: ConnectorStatus,
		error?: string,
	): void {
		const instance = this.instances.get(instanceId)
		if (instance) {
			instance.status = status
			instance.error = error
		}
	}

	private emit(event: ConnectorLifecycleEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event)
			} catch (err) {
				this.log.error('Connector event listener error', {
					error: toErrorMessage(err),
				})
			}
		}
	}
}
