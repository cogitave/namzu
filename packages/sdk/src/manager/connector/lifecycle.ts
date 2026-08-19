import type { BaseConnector } from '../../connector/BaseConnector.js'
import type { ConnectorRegistry } from '../../registry/connector/definitions.js'
import type {
	ConnectorConfig,
	ConnectorEventListener,
	ConnectorExecuteParams,
	ConnectorExecuteResult,
	ConnectorInstance,
	ConnectorLifecycleEvent,
	ConnectorOperationOptions,
	ConnectorStatus,
} from '../../types/connector/index.js'
import type { ConnectorId, ConnectorInstanceId } from '../../types/ids/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { generateConnectorInstanceId } from '../../utils/id.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'

export interface ConnectorManagerConfig {
	registry: ConnectorRegistry
	/**
	 * A pre-built, already-correlated logger. A caller that already knows
	 * something this manager cannot derive on its own — which tenant it was
	 * constructed for, most concretely (see `TenantConnectorManager`) —
	 * supplies one here so every record this manager's connectors log
	 * carries that correlation. Falls back to `getRootLogger()` when absent,
	 * same as before this field existed.
	 */
	log?: Logger
}

type Settled<T> = { kind: 'fulfilled'; value: T } | { kind: 'rejected'; reason: unknown }

async function settleWithSignal<T>(
	operation: Promise<T>,
	signal: AbortSignal | undefined,
	acceptAfterAbort?: (value: T) => boolean,
): Promise<T> {
	if (!signal) return operation
	const settled: Promise<Settled<T>> = operation.then(
		(value) => ({ kind: 'fulfilled', value }),
		(reason) => ({ kind: 'rejected', reason }),
	)
	let onAbort: (() => void) | undefined
	const aborted = new Promise<{ kind: 'aborted' }>((resolve) => {
		onAbort = () => resolve({ kind: 'aborted' })
		if (signal.aborted) {
			onAbort()
			return
		}
		signal.addEventListener('abort', onAbort, { once: true })
	})

	try {
		const winner = await Promise.race([settled, aborted])
		if (winner.kind !== 'aborted') {
			if (winner.kind === 'rejected') throw winner.reason
			if (signal.aborted && !acceptAfterAbort?.(winner.value)) throw signal.reason
			return winner.value
		}

		// A cooperative connector can preserve richer phase information (for
		// example response headers received but body unavailable). Give its abort
		// continuation one event-loop turn before abandoning an uncooperative
		// custom connector with the caller's reason.
		let timer: ReturnType<typeof setTimeout> | undefined
		const grace = await Promise.race([
			settled,
			new Promise<{ kind: 'grace_elapsed' }>((resolve) => {
				timer = setTimeout(() => resolve({ kind: 'grace_elapsed' }), 0)
			}),
		]).finally(() => {
			if (timer !== undefined) clearTimeout(timer)
		})
		if (grace.kind === 'fulfilled' && acceptAfterAbort?.(grace.value)) return grace.value
		if (grace.kind === 'rejected') throw grace.reason
		throw signal.reason
	} finally {
		if (onAbort) signal.removeEventListener('abort', onAbort)
	}
}

export class ConnectorManager {
	private registry: ConnectorRegistry
	private instances: Map<ConnectorInstanceId, ConnectorInstance> = new Map()
	private liveConnectors: Map<ConnectorInstanceId, BaseConnector<unknown>> = new Map()
	private listeners: ConnectorEventListener[] = []
	private log: Logger

	constructor(config: ConnectorManagerConfig) {
		this.registry = config.registry
		this.log = resolveLogger(config.log).child({ [SCOPE_ATTRIBUTE]: 'manager/connector' })
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
		this.log.info('Connector instance created', {
			'namzu.connector.instance_id': instanceId,
			'namzu.connector.id': config.connectorId,
		})

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
			this.log.info('Connector connected', { 'namzu.connector.instance_id': instanceId })
		} catch (err) {
			const message = toErrorMessage(err)
			this.updateStatus(instanceId, 'error', message)
			this.emit({ type: 'instance_error', instanceId, error: message })
			this.log.error('Connector connection failed', {
				'namzu.connector.instance_id': instanceId,
				'exception.message': message,
			})
			throw err
		}
	}

	async disconnect(instanceId: ConnectorInstanceId): Promise<void> {
		const connector = this.getConnectorOrThrow(instanceId)

		try {
			await connector.disconnect()
			this.updateStatus(instanceId, 'disconnected')
			this.emit({ type: 'instance_disconnected', instanceId })
			this.log.info('Connector disconnected', { 'namzu.connector.instance_id': instanceId })
		} catch (err) {
			const message = toErrorMessage(err)
			this.log.error('Connector disconnect failed', {
				'namzu.connector.instance_id': instanceId,
				'exception.message': message,
			})
			throw err
		}
	}

	async healthCheck(
		instanceId: ConnectorInstanceId,
		options?: ConnectorOperationOptions,
	): Promise<boolean> {
		const connector = this.getConnectorOrThrow(instanceId)
		if (options?.signal?.aborted) return false
		try {
			return await settleWithSignal(connector.healthCheck(options), options?.signal)
		} catch {
			return false
		}
	}

	async execute(params: ConnectorExecuteParams): Promise<ConnectorExecuteResult> {
		const instance = this.getInstanceOrThrow(params.instanceId)
		const connector = this.getConnectorOrThrow(params.instanceId)
		if (params.signal?.aborted) {
			return {
				success: false,
				output: null,
				error: `Connector execution was cancelled before it started: ${toErrorMessage(params.signal.reason)}. No remote request was started; retry is safe.`,
				durationMs: 0,
				metadata: { remoteOutcome: 'not_started', retrySafety: 'safe' },
			}
		}

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
			const result = await settleWithSignal(
				connector.execute(params.method, params.input, { signal: params.signal }),
				params.signal,
				(result) =>
					result.metadata?.remoteOutcome === 'response_received' ||
					(!result.success && result.metadata?.remoteOutcome !== undefined),
			)
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
				error: params.signal?.aborted
					? `Connector execution was interrupted: ${message}. The remote outcome is unknown; do not automatically retry.`
					: `Execution failed: ${message}`,
				durationMs,
				...(params.signal?.aborted
					? { metadata: { remoteOutcome: 'unknown' as const, retrySafety: 'unknown' as const } }
					: {}),
			}
		}
	}

	async removeInstance(instanceId: ConnectorInstanceId): Promise<void> {
		const instance = this.instances.get(instanceId)
		if (!instance) return

		if (instance.status === 'connected') {
			await this.disconnect(instanceId).catch((err) => {
				this.log.warn('Disconnect failed during removal', {
					'namzu.manager.instance_id': instanceId,
					'exception.message': toErrorMessage(err),
				})
			})
		}

		this.instances.delete(instanceId)
		this.liveConnectors.delete(instanceId)
		this.emit({ type: 'instance_removed', instanceId })
		this.log.info('Connector instance removed', { 'namzu.connector.instance_id': instanceId })
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
					'exception.message': toErrorMessage(err),
				})
			}
		}
	}
}
