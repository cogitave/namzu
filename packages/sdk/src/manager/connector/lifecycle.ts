import type { BaseConnector } from '../../connector/BaseConnector.js'
import { managedConnectorOptions } from '../../connector/execution-contract.js'
import type { ConnectorRegistry } from '../../registry/connector/definitions.js'
import { renderToolSchema } from '../../registry/tool/schema.js'
import type {
	AuthConfig,
	AuthType,
	ConnectorConfig,
	ConnectorDefinition,
	ConnectorEventListener,
	ConnectorExecuteParams,
	ConnectorExecuteResult,
	ConnectorInstance,
	ConnectorLifecycleEvent,
	ConnectorMethod,
	ConnectorOperationOptions,
	ConnectorStatus,
	ConnectorTrigger,
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

interface InstanceAdmission {
	readonly connectorId: ConnectorId
	readonly definition: ConnectorDefinition
	readonly supportedAuth?: ReadonlySet<AuthType>
}

function copyAuth(auth: AuthConfig): AuthConfig {
	return {
		type: auth.type,
		...(auth.credentials ? { credentials: { ...auth.credentials } } : {}),
	}
}

function sameAuthPolicy(
	registered: readonly AuthType[] | undefined,
	implementation: readonly AuthType[] | undefined,
): boolean {
	if (registered === undefined || implementation === undefined) {
		return registered === implementation
	}
	const expected = new Set(registered)
	const actual = new Set(implementation)
	return expected.size === actual.size && [...expected].every((authType) => actual.has(authType))
}

function sameMethodSurface(
	registered: readonly ConnectorMethod[],
	implementation: readonly ConnectorMethod[],
): boolean {
	const expected = new Set(registered.map((method) => method.name))
	const actual = new Set(implementation.map((method) => method.name))
	return (
		expected.size === registered.length &&
		actual.size === implementation.length &&
		expected.size === actual.size &&
		[...expected].every((name) => actual.has(name))
	)
}

function copyMethod(method: ConnectorMethod): ConnectorMethod {
	return { ...method }
}

function copyTrigger(trigger: ConnectorTrigger): ConnectorTrigger {
	return { ...trigger }
}

function copyDefinition(definition: ConnectorDefinition): ConnectorDefinition {
	return {
		...definition,
		...(definition.supportedAuth ? { supportedAuth: [...definition.supportedAuth] } : {}),
		methods: definition.methods.map(copyMethod),
		...(definition.triggers ? { triggers: definition.triggers.map(copyTrigger) } : {}),
	}
}

function assertMethodSchemas(definition: ConnectorDefinition): void {
	for (const method of definition.methods) {
		try {
			renderToolSchema(method.inputSchema)
			if (method.outputSchema) renderToolSchema(method.outputSchema)
		} catch (err) {
			throw new Error(
				`Connector method "${method.name}" on "${definition.id}" has a schema that cannot be projected: ${toErrorMessage(err)}`,
			)
		}
	}
}

function formatSchemaIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
	return issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
}

function formatOutputSchemaIssues(
	issues: readonly { path: PropertyKey[]; code: string }[],
): string {
	return issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`).join('; ')
}

function notStartedFailure(error: string): ConnectorExecuteResult {
	return {
		success: false,
		output: null,
		error,
		durationMs: 0,
		metadata: { remoteOutcome: 'not_started', retrySafety: 'safe' },
	}
}

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
	private admissions: Map<ConnectorInstanceId, InstanceAdmission> = new Map()
	private listeners: ConnectorEventListener[] = []
	private log: Logger

	constructor(config: ConnectorManagerConfig) {
		this.registry = config.registry
		this.log = resolveLogger(config.log).child({
			[SCOPE_ATTRIBUTE]: 'manager/connector',
		})
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
		if (connector.id !== config.connectorId) {
			throw new Error(
				`Connector implementation id "${connector.id}" does not match requested definition "${config.connectorId}"`,
			)
		}
		if (!sameAuthPolicy(definition.supportedAuth, connector.supportedAuth)) {
			throw new Error(
				`Connector implementation "${connector.id}" does not match its registered auth policy`,
			)
		}
		assertMethodSchemas(definition)
		if (!sameMethodSurface(definition.methods, connector.methods)) {
			throw new Error(
				`Connector implementation "${connector.id}" does not match its registered method surface`,
			)
		}
		const capturedDefinition = copyDefinition(definition)
		const admission: InstanceAdmission = {
			connectorId: config.connectorId,
			definition: capturedDefinition,
			...(capturedDefinition.supportedAuth
				? { supportedAuth: new Set(capturedDefinition.supportedAuth) }
				: {}),
		}
		if (config.auth) this.requireSupportedAuth(admission, config.connectorId, config.auth.type)

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
		this.admissions.set(instanceId, admission)
		this.emit({
			type: 'instance_created',
			instanceId,
			connectorId: config.connectorId,
		})
		this.log.info('Connector instance created', {
			'namzu.connector.instance_id': instanceId,
			'namzu.connector.id': config.connectorId,
		})

		return instance
	}

	async connect(instanceId: ConnectorInstanceId): Promise<void> {
		const instance = this.getInstanceOrThrow(instanceId)
		const connector = this.getConnectorOrThrow(instanceId)
		const admission = this.getAdmissionOrThrow(instanceId)

		try {
			const parsedConfig = admission.definition.configSchema.parse(instance.config.options ?? {})
			this.requireSupportedAuth(
				admission,
				admission.connectorId,
				instance.config.auth?.type ?? 'none',
			)
			this.updateStatus(instanceId, 'connecting')
			this.emit({ type: 'instance_connecting', instanceId })
			await connector.connect(parsedConfig, instance.config.auth)
			this.updateStatus(instanceId, 'connected')
			instance.connectedAt = Date.now()
			this.emit({ type: 'instance_connected', instanceId })
			this.log.info('Connector connected', {
				'namzu.connector.instance_id': instanceId,
			})
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
			this.log.info('Connector disconnected', {
				'namzu.connector.instance_id': instanceId,
			})
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
		const admission = this.getAdmissionOrThrow(params.instanceId)
		if (params.signal?.aborted) {
			return notStartedFailure(
				`Connector execution was cancelled before it started: ${toErrorMessage(params.signal.reason)}. No remote request was started; retry is safe.`,
			)
		}

		const method = admission.definition.methods.find(
			(candidate) => candidate.name === params.method,
		)
		if (!method) {
			const available = admission.definition.methods.map((candidate) => candidate.name).join(', ')
			return notStartedFailure(
				`Connector method "${params.method}" is not registered for "${admission.connectorId}". Available: ${available || '(none)'}. No remote request was started; retry is safe after correcting the method.`,
			)
		}

		if (instance.status !== 'connected') {
			return notStartedFailure(
				`Connector "${params.instanceId}" is not connected (status: ${instance.status}). No remote request was started; retry is safe after connecting it.`,
			)
		}

		let canonicalInput: unknown
		try {
			const parsedInput = await settleWithSignal(
				method.inputSchema.safeParseAsync(params.input),
				params.signal,
			)
			if (!parsedInput.success) {
				return notStartedFailure(
					`Invalid input for connector method "${params.method}": ${formatSchemaIssues(parsedInput.error.issues)}. No remote request was started; retry is safe after correcting the input.`,
				)
			}
			canonicalInput = parsedInput.data
		} catch (err) {
			if (params.signal?.aborted) {
				return notStartedFailure(
					`Connector execution was cancelled during input validation: ${toErrorMessage(params.signal.reason)}. No remote request was started; retry is safe.`,
				)
			}
			return notStartedFailure(
				`Input validation failed for connector method "${params.method}": ${toErrorMessage(err)}. No remote request was started; retry is safe after correcting the connector schema or input.`,
			)
		}

		if (params.signal?.aborted) {
			return notStartedFailure(
				`Connector execution was cancelled before it started: ${toErrorMessage(params.signal.reason)}. No remote request was started; retry is safe.`,
			)
		}

		this.emit({
			type: 'action_executing',
			instanceId: params.instanceId,
			method: params.method,
		})
		const start = performance.now()
		try {
			const result = await settleWithSignal(
				connector.execute(
					params.method,
					canonicalInput,
					managedConnectorOptions({ signal: params.signal }),
				),
				params.signal,
				(result) =>
					result.metadata?.remoteOutcome === 'response_received' ||
					(!result.success && result.metadata?.remoteOutcome !== undefined),
			)
			instance.lastUsedAt = Date.now()
			let published = result
			if (result.success && method.outputSchema) {
				try {
					const parsedOutput = await settleWithSignal(
						method.outputSchema.safeParseAsync(result.output),
						params.signal,
					)
					published = parsedOutput.success
						? { ...result, output: parsedOutput.data }
						: {
								success: false,
								output: null,
								error: `Connector method "${params.method}" returned output that violates its registered schema: ${formatOutputSchemaIssues(parsedOutput.error.issues)}. A remote response was received; do not automatically retry.`,
								durationMs: result.durationMs,
								metadata: {
									...result.metadata,
									remoteOutcome: 'response_received',
									retrySafety: 'unsafe',
								},
							}
				} catch {
					published = {
						success: false,
						output: null,
						error: `Connector method "${params.method}" output validation could not establish the registered contract. A remote response was received; do not automatically retry.`,
						durationMs: result.durationMs,
						metadata: {
							...result.metadata,
							remoteOutcome: 'response_received',
							retrySafety: 'unsafe',
						},
					}
				}
			}
			this.emit({
				type: 'action_completed',
				instanceId: params.instanceId,
				method: params.method,
				success: published.success,
				durationMs: published.durationMs,
			})
			return published
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
					? {
							metadata: {
								remoteOutcome: 'unknown' as const,
								retrySafety: 'unknown' as const,
							},
						}
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
		this.admissions.delete(instanceId)
		this.emit({ type: 'instance_removed', instanceId })
		this.log.info('Connector instance removed', {
			'namzu.connector.instance_id': instanceId,
		})
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

	getInstanceConnectorId(instanceId: ConnectorInstanceId): ConnectorId {
		return this.getAdmissionOrThrow(instanceId).connectorId
	}

	getInstanceDefinition(instanceId: ConnectorInstanceId): ConnectorDefinition {
		return copyDefinition(this.getAdmissionOrThrow(instanceId).definition)
	}

	supportsAuth(instanceId: ConnectorInstanceId, authType: AuthType): boolean {
		const supported = this.getAdmissionOrThrow(instanceId).supportedAuth
		return supported === undefined || supported.has(authType)
	}

	/** Validate before mutating the live instance's effective credential. */
	setInstanceAuth(instanceId: ConnectorInstanceId, auth: AuthConfig): void {
		const instance = this.getInstanceOrThrow(instanceId)
		const admission = this.getAdmissionOrThrow(instanceId)
		this.requireSupportedAuth(admission, admission.connectorId, auth.type)
		instance.config.auth = copyAuth(auth)
	}

	listInstances(): ConnectorInstance[] {
		return Array.from(this.instances.values())
	}

	listInstancesByConnector(connectorId: ConnectorId): ConnectorInstance[] {
		return this.listInstances().filter(
			(instance) => this.getAdmissionOrThrow(instance.id).connectorId === connectorId,
		)
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

	private getAdmissionOrThrow(instanceId: ConnectorInstanceId): InstanceAdmission {
		const admission = this.admissions.get(instanceId)
		if (!admission) {
			throw new Error(`Connector admission policy not found for instance: "${instanceId}"`)
		}
		return admission
	}

	private requireSupportedAuth(
		admission: InstanceAdmission,
		connectorId: ConnectorId,
		authType: AuthType,
	): void {
		const supported = admission.supportedAuth
		if (supported === undefined || supported.has(authType)) return
		const available = [...supported].join(', ') || 'none'
		throw new Error(
			`Connector "${connectorId}" does not support auth scheme "${authType}". Supported: ${available}`,
		)
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
