import type { BaseConnector } from '../../connector/BaseConnector.js'
import { ExecutionContextFactory } from '../../connector/execution/factory.js'
import type { BaseExecutionContext } from '../../execution/base.js'
import type { ConnectorRegistry } from '../../registry/connector/definitions.js'
import type { ScopedConnectorRegistry } from '../../registry/connector/scoped.js'
import type {
	ConnectorConfig,
	ConnectorEventListener,
	ConnectorExecuteParams,
	ConnectorExecuteResult,
	ConnectorInstance,
	ConnectorLifecycleEvent,
	CredentialVault,
	EnvironmentDescriptor,
	ExecutionContextConfig,
	ResolvedConnectorConfig,
	ScopeChain,
} from '../../types/connector/index.js'
import type { EnvironmentId } from '../../types/ids/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'
import { ConnectorManager } from './lifecycle.js'

export interface EnvironmentConnectorSetup {
	environment: EnvironmentDescriptor

	scopeChain: ScopeChain

	executionContext?: ExecutionContextConfig

	connectorOverrides?: Record<string, Partial<ConnectorConfig>>
}

export interface EnvironmentConnectorManagerConfig {
	connectorRegistry: ConnectorRegistry

	scopedRegistry: ScopedConnectorRegistry

	credentialVault?: CredentialVault
}

interface EnvironmentState {
	descriptor: EnvironmentDescriptor
	scopeChain: ScopeChain
	manager: ConnectorManager
	executionContext?: BaseExecutionContext
	connectorOverrides: Record<string, Partial<ConnectorConfig>>
}

export class EnvironmentConnectorManager {
	private environments: Map<EnvironmentId, EnvironmentState> = new Map()
	private connectorRegistry: ConnectorRegistry
	private scopedRegistry: ScopedConnectorRegistry
	private credentialVault: CredentialVault | undefined
	private listeners: ConnectorEventListener[] = []
	private log: Logger

	constructor(config: EnvironmentConnectorManagerConfig) {
		this.connectorRegistry = config.connectorRegistry
		this.scopedRegistry = config.scopedRegistry
		this.credentialVault = config.credentialVault
		this.log = getRootLogger().child({ component: 'EnvironmentConnectorManager' })
	}

	registerEnvironment(setup: EnvironmentConnectorSetup): void {
		const envId = setup.environment.id
		if (this.environments.has(envId)) {
			this.log.warn(`Environment "${envId}" already registered, skipping.`)
			return
		}

		const manager = new ConnectorManager({ registry: this.connectorRegistry })

		manager.on((event) => this.emit(event))

		let executionContext: BaseExecutionContext | undefined
		if (setup.executionContext) {
			executionContext = ExecutionContextFactory.create(setup.executionContext)
		}

		this.environments.set(envId, {
			descriptor: setup.environment,
			scopeChain: setup.scopeChain,
			manager,
			executionContext,
			connectorOverrides: setup.connectorOverrides ?? {},
		})

		this.log.info(
			`Environment registered: ${envId} (${setup.environment.name}, tier=${setup.environment.tier})`,
		)
	}

	async initializeEnvironment(envId: EnvironmentId): Promise<void> {
		const state = this.getEnvironmentOrThrow(envId)
		if (state.executionContext) {
			await state.executionContext.initialize()
			this.log.info(`Environment "${envId}" execution context initialized`)
		}
	}

	async unregisterEnvironment(envId: EnvironmentId): Promise<void> {
		const state = this.environments.get(envId)
		if (!state) return

		await state.manager.disconnectAll()
		if (state.executionContext) {
			await state.executionContext.teardown()
		}
		this.environments.delete(envId)
		this.log.info(`Environment unregistered: ${envId}`)
	}

	getEnvironment(envId: EnvironmentId): EnvironmentDescriptor | undefined {
		return this.environments.get(envId)?.descriptor
	}

	listEnvironments(): EnvironmentDescriptor[] {
		return Array.from(this.environments.values()).map((s) => s.descriptor)
	}

	resolveConnectorConfig(
		envId: EnvironmentId,
		connectorId: string,
	): ResolvedConnectorConfig | undefined {
		const state = this.getEnvironmentOrThrow(envId)
		const resolved = this.scopedRegistry.resolve(connectorId, state.scopeChain)
		if (!resolved) return undefined

		const overrides = state.connectorOverrides[connectorId]
		if (overrides) {
			if (overrides.auth) {
				resolved.auth = overrides.auth
				resolved.config.auth = overrides.auth
			}
			if (overrides.options) {
				resolved.options = { ...resolved.options, ...overrides.options }
				resolved.config.options = resolved.options
			}
			if (overrides.name) {
				resolved.config.name = overrides.name
			}
		}

		return resolved
	}

	async createConnectorFromScope(
		envId: EnvironmentId,
		connectorId: string,
		connector: BaseConnector<unknown>,
	): Promise<ConnectorInstance> {
		const state = this.getEnvironmentOrThrow(envId)
		const resolved = this.resolveConnectorConfig(envId, connectorId)

		if (!resolved) {
			throw new Error(
				`No scoped config for connector "${connectorId}" in environment "${envId}". ` +
					`Scope chain: ${JSON.stringify(state.scopeChain)}`,
			)
		}

		if (!resolved.enabled) {
			throw new Error(`Connector "${connectorId}" is disabled in environment "${envId}"`)
		}

		return state.manager.createInstance(resolved.config, connector)
	}

	async connect(
		envId: EnvironmentId,
		instanceId: import('../../types/ids/index.js').ConnectorInstanceId,
	): Promise<void> {
		const state = this.getEnvironmentOrThrow(envId)
		return state.manager.connect(instanceId)
	}

	async disconnect(
		envId: EnvironmentId,
		instanceId: import('../../types/ids/index.js').ConnectorInstanceId,
	): Promise<void> {
		const state = this.getEnvironmentOrThrow(envId)
		return state.manager.disconnect(instanceId)
	}

	async execute(
		envId: EnvironmentId,
		params: ConnectorExecuteParams,
	): Promise<ConnectorExecuteResult> {
		const state = this.getEnvironmentOrThrow(envId)
		return state.manager.execute(params)
	}

	async healthCheck(
		envId: EnvironmentId,
		instanceId: import('../../types/ids/index.js').ConnectorInstanceId,
	): Promise<boolean> {
		const state = this.getEnvironmentOrThrow(envId)
		return state.manager.healthCheck(instanceId)
	}

	listInstances(envId: EnvironmentId): ConnectorInstance[] {
		const state = this.getEnvironmentOrThrow(envId)
		return state.manager.listInstances()
	}

	listConnectedInstances(envId: EnvironmentId): ConnectorInstance[] {
		const state = this.getEnvironmentOrThrow(envId)
		return state.manager.listConnectedInstances()
	}

	getExecutionContext(envId: EnvironmentId): BaseExecutionContext | undefined {
		return this.environments.get(envId)?.executionContext
	}

	getConnectorManager(envId: EnvironmentId): ConnectorManager {
		return this.getEnvironmentOrThrow(envId).manager
	}

	getScopedRegistry(): ScopedConnectorRegistry {
		return this.scopedRegistry
	}

	getCredentialVault(): CredentialVault | undefined {
		return this.credentialVault
	}

	async teardownAll(): Promise<void> {
		const envIds = Array.from(this.environments.keys())
		await Promise.allSettled(envIds.map((envId) => this.unregisterEnvironment(envId)))
	}

	on(listener: ConnectorEventListener): void {
		this.listeners.push(listener)
	}

	off(listener: ConnectorEventListener): void {
		const index = this.listeners.indexOf(listener)
		if (index >= 0) this.listeners.splice(index, 1)
	}

	private emit(event: ConnectorLifecycleEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event)
			} catch (err) {
				this.log.error('Environment event listener error', {
					error: toErrorMessage(err),
				})
			}
		}
	}

	private getEnvironmentOrThrow(envId: EnvironmentId): EnvironmentState {
		const state = this.environments.get(envId)
		if (!state) {
			throw new Error(
				`Environment not found: "${envId}". Register it first via registerEnvironment().`,
			)
		}
		return state
	}
}
