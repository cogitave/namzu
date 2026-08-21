import type { BaseConnector } from '../../connector/BaseConnector.js'
import { NAMZU } from '../../constants/telemetry/index.js'
import type { ConnectorRegistry } from '../../registry/connector/definitions.js'
import type {
	AuthConfig,
	AuthType,
	ConnectorConfig,
	ConnectorEventListener,
	ConnectorExecuteParams,
	ConnectorExecuteResult,
	ConnectorInstance,
	ConnectorLifecycleEvent,
	ConnectorOperationOptions,
	CredentialVault,
	TenantDescriptor,
	TenantRateLimitConfig,
} from '../../types/connector/index.js'
import type {
	ConnectorId,
	ConnectorInstanceId,
	CredentialId,
	TenantId,
} from '../../types/ids/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
import { ConnectorManager } from './lifecycle.js'

interface RateWindow {
	timestamps: number[]
}

export interface TenantConnectorManagerConfig {
	registry: ConnectorRegistry

	credentialVault?: CredentialVault

	defaultRateLimit?: TenantRateLimitConfig

	/**
	 * A pre-built logger. `registerTenant` already builds a per-tenant CHILD
	 * of `this.log` (bound with `namzu.tenant.id`) and hands it to each
	 * tenant's `ConnectorManager` — this field was the one remaining gap: the
	 * manager's OWN construction-time logger still had no injection point at
	 * all. Falls back to the process logger when absent.
	 */
	log?: Logger
}

interface TenantState {
	descriptor: TenantDescriptor
	manager: ConnectorManager
	rateLimit?: TenantRateLimitConfig
	rateWindows: Map<ConnectorInstanceId, RateWindow>
}

export class TenantConnectorManager {
	private tenants: Map<TenantId, TenantState> = new Map()
	private registry: ConnectorRegistry
	private credentialVault: CredentialVault | undefined
	private defaultRateLimit: TenantRateLimitConfig | undefined
	private listeners: ConnectorEventListener[] = []
	private log: Logger

	constructor(config: TenantConnectorManagerConfig) {
		this.registry = config.registry
		this.credentialVault = config.credentialVault
		this.defaultRateLimit = config.defaultRateLimit
		this.log = resolveLogger(config.log).child({
			[SCOPE_ATTRIBUTE]: 'manager/connector',
		})
	}

	registerTenant(descriptor: TenantDescriptor, rateLimit?: TenantRateLimitConfig): void {
		if (this.tenants.has(descriptor.id)) {
			this.log.warn('Tenant already registered, skipping', {
				[NAMZU.TENANT_ID]: descriptor.id,
			})
			return
		}

		const tenantLog = this.log.child({ [NAMZU.TENANT_ID]: descriptor.id })
		const manager = new ConnectorManager({
			registry: this.registry,
			log: tenantLog,
		})

		manager.on((event) => {
			this.emitTenantEvent(descriptor.id, event)
		})

		this.tenants.set(descriptor.id, {
			descriptor,
			manager,
			rateLimit: rateLimit ?? this.defaultRateLimit,
			rateWindows: new Map(),
		})

		this.log.info('Tenant registered', {
			[NAMZU.TENANT_ID]: descriptor.id,
			'namzu.tenant.name': descriptor.name,
		})
	}

	async unregisterTenant(tenantId: TenantId): Promise<void> {
		const state = this.tenants.get(tenantId)
		if (!state) return

		await state.manager.disconnectAll()
		this.tenants.delete(tenantId)
		this.log.info('Tenant unregistered', { [NAMZU.TENANT_ID]: tenantId })
	}

	getTenant(tenantId: TenantId): TenantDescriptor | undefined {
		return this.tenants.get(tenantId)?.descriptor
	}

	listTenants(): TenantDescriptor[] {
		return Array.from(this.tenants.values()).map((s) => s.descriptor)
	}

	setTenantRateLimit(tenantId: TenantId, rateLimit: TenantRateLimitConfig): void {
		const state = this.getTenantOrThrow(tenantId)
		state.rateLimit = rateLimit
	}

	private checkRateLimit(state: TenantState, instanceId: ConnectorInstanceId): boolean {
		const limit = state.rateLimit
		if (!limit) return true

		const now = Date.now()
		let window = state.rateWindows.get(instanceId)
		if (!window) {
			window = { timestamps: [] }
			state.rateWindows.set(instanceId, window)
		}

		window.timestamps = window.timestamps.filter((t) => now - t < limit.windowMs)

		if (window.timestamps.length >= limit.maxRequests) {
			return false
		}

		window.timestamps.push(now)
		return true
	}

	async createInstance(
		tenantId: TenantId,
		config: ConnectorConfig,
		connector: BaseConnector<unknown>,
	): Promise<ConnectorInstance> {
		const state = this.getTenantOrThrow(tenantId)
		return state.manager.createInstance(config, connector)
	}

	async connect(tenantId: TenantId, instanceId: ConnectorInstanceId): Promise<void> {
		const state = this.getTenantOrThrow(tenantId)

		if (this.credentialVault) {
			const instance = state.manager.getInstance(instanceId)
			if (instance && !instance.config.auth) {
				const connectorId = state.manager.getInstanceConnectorId(instanceId)
				const creds = await this.credentialVault.list(tenantId, connectorId)
				for (const ref of creds) {
					if (!state.manager.supportsAuth(instanceId, ref.authType)) continue
					const auth = await this.credentialVault.retrieveForScope(tenantId, connectorId, ref.id)
					if (!auth || !state.manager.supportsAuth(instanceId, auth.type)) continue
					state.manager.setInstanceAuth(instanceId, auth)
					this.log.info('Auto-resolved credential for instance', {
						[NAMZU.CREDENTIAL_ID]: ref.id,
						'namzu.connector.instance_id': instanceId,
						[NAMZU.TENANT_ID]: tenantId,
					})
					break
				}
			}
		}

		return state.manager.connect(instanceId)
	}

	async connectWithCredential(
		tenantId: TenantId,
		instanceId: ConnectorInstanceId,
		credentialId: CredentialId,
	): Promise<void> {
		if (!this.credentialVault) {
			throw new Error('No credential vault configured on TenantConnectorManager')
		}

		const state = this.getTenantOrThrow(tenantId)
		const instance = state.manager.getInstance(instanceId)
		if (!instance) {
			throw new Error(`Connector instance not found: "${instanceId}"`)
		}
		const connectorId = state.manager.getInstanceConnectorId(instanceId)

		const auth = await this.credentialVault.retrieveForScope(tenantId, connectorId, credentialId)
		if (!auth) {
			throw new Error(
				`Credential "${credentialId}" is unavailable for tenant "${tenantId}" and connector "${connectorId}"`,
			)
		}

		state.manager.setInstanceAuth(instanceId, auth)
		this.log.info('Credential applied to instance', {
			[NAMZU.CREDENTIAL_ID]: credentialId,
			'namzu.connector.instance_id': instanceId,
			[NAMZU.TENANT_ID]: tenantId,
		})
		return state.manager.connect(instanceId)
	}

	async storeCredential(
		tenantId: TenantId,
		connectorId: ConnectorId,
		label: string,
		auth: AuthConfig,
	): Promise<import('../../types/connector/index.js').CredentialRef> {
		if (!this.credentialVault) {
			throw new Error('No credential vault configured on TenantConnectorManager')
		}
		this.getTenantOrThrow(tenantId)
		this.requireDefinitionSupportsAuth(connectorId, auth.type)
		return this.credentialVault.store(tenantId, connectorId, label, auth)
	}

	async listCredentials(
		tenantId: TenantId,
		connectorId?: ConnectorId,
	): Promise<import('../../types/connector/index.js').CredentialRef[]> {
		if (!this.credentialVault) {
			return []
		}
		this.getTenantOrThrow(tenantId)
		return this.credentialVault.list(tenantId, connectorId)
	}

	async revokeCredential(tenantId: TenantId, credentialId: CredentialId): Promise<boolean> {
		if (!this.credentialVault) {
			return false
		}
		this.getTenantOrThrow(tenantId)
		return this.credentialVault.revokeForTenant(tenantId, credentialId)
	}

	async disconnect(tenantId: TenantId, instanceId: ConnectorInstanceId): Promise<void> {
		const state = this.getTenantOrThrow(tenantId)
		return state.manager.disconnect(instanceId)
	}

	async execute(
		tenantId: TenantId,
		params: ConnectorExecuteParams,
	): Promise<ConnectorExecuteResult> {
		const state = this.getTenantOrThrow(tenantId)
		// A caller that has already withdrawn authority did not attempt a remote
		// operation and must not spend the tenant's next admission slot. Delegate
		// first so the ordinary manager still validates the instance and returns
		// the canonical not-started phase result.
		if (params.signal?.aborted) return state.manager.execute(params)

		if (!this.checkRateLimit(state, params.instanceId)) {
			return {
				success: false,
				output: null,
				error: `Rate limit exceeded for tenant "${tenantId}" on instance "${params.instanceId}"`,
				durationMs: 0,
			}
		}

		return state.manager.execute(params)
	}

	async healthCheck(
		tenantId: TenantId,
		instanceId: ConnectorInstanceId,
		options?: ConnectorOperationOptions,
	): Promise<boolean> {
		const state = this.getTenantOrThrow(tenantId)
		return state.manager.healthCheck(instanceId, options)
	}

	async removeInstance(tenantId: TenantId, instanceId: ConnectorInstanceId): Promise<void> {
		const state = this.getTenantOrThrow(tenantId)
		return state.manager.removeInstance(instanceId)
	}

	listInstances(tenantId: TenantId): ConnectorInstance[] {
		const state = this.getTenantOrThrow(tenantId)
		return state.manager.listInstances()
	}

	listConnectedInstances(tenantId: TenantId): ConnectorInstance[] {
		const state = this.getTenantOrThrow(tenantId)
		return state.manager.listConnectedInstances()
	}

	getManagerForTenant(tenantId: TenantId): ConnectorManager {
		return this.getTenantOrThrow(tenantId).manager
	}

	getCredentialVault(): CredentialVault | undefined {
		return this.credentialVault
	}

	async disconnectAll(): Promise<void> {
		const promises: Promise<void>[] = []
		for (const state of this.tenants.values()) {
			promises.push(state.manager.disconnectAll())
		}
		await Promise.allSettled(promises)
	}

	on(listener: ConnectorEventListener): void {
		this.listeners.push(listener)
	}

	off(listener: ConnectorEventListener): void {
		const index = this.listeners.indexOf(listener)
		if (index >= 0) this.listeners.splice(index, 1)
	}

	private emitTenantEvent(tenantId: TenantId, event: ConnectorLifecycleEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event)
			} catch (err) {
				this.log.error('Tenant event listener error', {
					'namzu.manager.tenant_id': tenantId,
					'exception.message': toErrorMessage(err),
				})
			}
		}
	}

	private getTenantOrThrow(tenantId: TenantId): TenantState {
		const state = this.tenants.get(tenantId)
		if (!state) {
			throw new Error(`Tenant not found: "${tenantId}". Register it first via registerTenant().`)
		}
		return state
	}

	private requireDefinitionSupportsAuth(connectorId: ConnectorId, authType: AuthType): void {
		const supported = this.registry.getOrThrow(connectorId).supportedAuth
		if (supported === undefined || supported.includes(authType)) return
		throw new Error(
			`Connector "${connectorId}" does not support auth scheme "${authType}". Supported: ${supported.join(', ') || 'none'}`,
		)
	}
}
