import type { BaseConnector } from '../../connector/BaseConnector.js'
import type { ConnectorRegistry } from '../../registry/connector/definitions.js'
import type {
	ConnectorConfig,
	ConnectorEventListener,
	ConnectorExecuteParams,
	ConnectorExecuteResult,
	ConnectorInstance,
	ConnectorLifecycleEvent,
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
import { type Logger, getRootLogger } from '../../utils/logger.js'
import { ConnectorManager } from './lifecycle.js'

interface RateWindow {
	timestamps: number[]
}

export interface TenantConnectorManagerConfig {
	registry: ConnectorRegistry

	credentialVault?: CredentialVault

	defaultRateLimit?: TenantRateLimitConfig
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
		this.log = getRootLogger().child({ component: 'TenantConnectorManager' })
	}

	registerTenant(descriptor: TenantDescriptor, rateLimit?: TenantRateLimitConfig): void {
		if (this.tenants.has(descriptor.id)) {
			this.log.warn(`Tenant "${descriptor.id}" already registered, skipping.`)
			return
		}

		const manager = new ConnectorManager({ registry: this.registry })

		manager.on((event) => {
			this.emitTenantEvent(descriptor.id, event)
		})

		this.tenants.set(descriptor.id, {
			descriptor,
			manager,
			rateLimit: rateLimit ?? this.defaultRateLimit,
			rateWindows: new Map(),
		})

		this.log.info(`Tenant registered: ${descriptor.id} (${descriptor.name})`)
	}

	async unregisterTenant(tenantId: TenantId): Promise<void> {
		const state = this.tenants.get(tenantId)
		if (!state) return

		await state.manager.disconnectAll()
		this.tenants.delete(tenantId)
		this.log.info(`Tenant unregistered: ${tenantId}`)
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
				const creds = await this.credentialVault.list(tenantId, instance.connectorId)
				const credId = creds[0]?.id
				if (credId) {
					const auth = await this.credentialVault.retrieve(credId)
					if (auth) {
						instance.config.auth = auth
						this.log.info(
							`Auto-resolved credential "${credId}" for instance "${instanceId}" (tenant: ${tenantId})`,
						)
					}
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

		const auth = await this.credentialVault.retrieve(credentialId)
		if (!auth) {
			throw new Error(`Credential not found: "${credentialId}"`)
		}

		instance.config.auth = auth
		this.log.info(
			`Credential "${credentialId}" applied to instance "${instanceId}" (tenant: ${tenantId})`,
		)
		return state.manager.connect(instanceId)
	}

	async storeCredential(
		tenantId: TenantId,
		connectorId: ConnectorId,
		label: string,
		auth: import('../../types/connector/index.js').AuthConfig,
	): Promise<import('../../types/connector/index.js').CredentialRef> {
		if (!this.credentialVault) {
			throw new Error('No credential vault configured on TenantConnectorManager')
		}
		this.getTenantOrThrow(tenantId)
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

	async revokeCredential(credentialId: CredentialId): Promise<boolean> {
		if (!this.credentialVault) {
			return false
		}
		return this.credentialVault.revoke(credentialId)
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

	async healthCheck(tenantId: TenantId, instanceId: ConnectorInstanceId): Promise<boolean> {
		const state = this.getTenantOrThrow(tenantId)
		return state.manager.healthCheck(instanceId)
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
					tenantId,
					error: toErrorMessage(err),
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
}
