import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { BaseConnector } from '../../../connector/BaseConnector.js'
import { WebhookConnector } from '../../../connector/builtins/webhook.js'
import { ConnectorRegistry } from '../../../registry/connector/definitions.js'
import type {
	AuthConfig,
	AuthType,
	ConnectionType,
	ConnectorExecuteResult,
	ConnectorMethod,
	CredentialRef,
	CredentialVault,
} from '../../../types/connector/index.js'
import type { ConnectorId, CredentialId, TenantId } from '../../../types/ids/index.js'
import { InMemoryCredentialVault } from '../../../vault/InMemoryCredentialVault.js'
import { ConnectorManager } from '../lifecycle.js'
import { TenantConnectorManager } from '../tenant.js'

const TENANT_A = 'tnt_a' as TenantId
const TENANT_B = 'tnt_b' as TenantId
const CONNECTOR_A = 'conn_a' as ConnectorId
const CONNECTOR_B = 'conn_b' as ConnectorId

class RecordingConnector extends BaseConnector<Record<string, never>> {
	readonly id: ConnectorId
	readonly name = 'Recording connector'
	readonly description = 'Records connect calls without external I/O'
	readonly connectionType: ConnectionType = 'custom'
	override readonly supportedAuth: readonly AuthType[]
	readonly configSchema = z.object({})
	readonly methods: ConnectorMethod[] = []
	readonly connectCalls: Array<AuthConfig | undefined> = []

	constructor(id: ConnectorId, supportedAuth: readonly AuthType[]) {
		super()
		this.id = id
		this.supportedAuth = supportedAuth
	}

	async connect(_config: Record<string, never>, auth?: AuthConfig): Promise<void> {
		this.connectCalls.push(auth)
	}

	async disconnect(): Promise<void> {}

	async healthCheck(): Promise<boolean> {
		return true
	}

	async execute(): Promise<ConnectorExecuteResult> {
		return { success: true, output: null, durationMs: 0 }
	}
}

/** A tenant facade must never fall back to either host-authority operation. */
class ScopedOnlyVault implements CredentialVault {
	readonly inner = new InMemoryCredentialVault()
	readonly scopedLookups: [TenantId, ConnectorId, CredentialId][] = []
	readonly scopedRevokes: [TenantId, CredentialId][] = []
	listOverride: readonly CredentialRef[] | undefined
	storeCalls = 0

	async store(
		tenantId: TenantId,
		connectorId: ConnectorId,
		label: string,
		auth: AuthConfig,
	): Promise<CredentialRef> {
		this.storeCalls++
		return this.inner.store(tenantId, connectorId, label, auth)
	}

	async retrieve(_credentialId: CredentialId): Promise<AuthConfig | undefined> {
		throw new Error('host-authority retrieve must not be reachable')
	}

	retrieveForScope(
		tenantId: TenantId,
		connectorId: ConnectorId,
		credentialId: CredentialId,
	): Promise<AuthConfig | undefined> {
		this.scopedLookups.push([tenantId, connectorId, credentialId])
		return this.inner.retrieveForScope(tenantId, connectorId, credentialId)
	}

	async revoke(_credentialId: CredentialId): Promise<boolean> {
		throw new Error('host-authority revoke must not be reachable')
	}

	revokeForTenant(tenantId: TenantId, credentialId: CredentialId): Promise<boolean> {
		this.scopedRevokes.push([tenantId, credentialId])
		return this.inner.revokeForTenant(tenantId, credentialId)
	}

	async list(tenantId: TenantId, connectorId?: ConnectorId): Promise<CredentialRef[]> {
		if (this.listOverride) {
			return this.listOverride
				.filter(
					(ref) => ref.tenantId === tenantId && (!connectorId || ref.connectorId === connectorId),
				)
				.map((ref) => ({ ...ref }))
		}
		return this.inner.list(tenantId, connectorId)
	}
}

function bearer(token: string): AuthConfig {
	return { type: 'bearer', credentials: { token } }
}

function registerTenantConnectors(registry: ConnectorRegistry): void {
	registry.register(new RecordingConnector(CONNECTOR_A, ['bearer']).toDefinition())
	registry.register(new RecordingConnector(CONNECTOR_B, ['bearer']).toDefinition())
}

describe('TenantConnectorManager credential authority', () => {
	it('does not let a credential id cross tenant or connector scope, including revoke', async () => {
		const registry = new ConnectorRegistry()
		registerTenantConnectors(registry)
		const vault = new ScopedOnlyVault()
		const manager = new TenantConnectorManager({
			registry,
			credentialVault: vault,
		})
		manager.registerTenant({ id: TENANT_A, name: 'A' })
		manager.registerTenant({ id: TENANT_B, name: 'B' })

		const ref = await manager.storeCredential(
			TENANT_A,
			CONNECTOR_A,
			'A bearer',
			bearer('tenant-a-secret'),
		)
		const connectorBRef = await manager.storeCredential(
			TENANT_A,
			CONNECTOR_B,
			'A connector-B bearer',
			bearer('connector-b-secret'),
		)
		const tenantBConnector = new RecordingConnector(CONNECTOR_A, ['bearer'])
		const tenantBInstance = await manager.createInstance(
			TENANT_B,
			{ connectorId: CONNECTOR_A, name: 'B/A' },
			tenantBConnector,
		)
		const connectorB = new RecordingConnector(CONNECTOR_B, ['bearer'])
		const connectorBInstance = await manager.createInstance(
			TENANT_A,
			{ connectorId: CONNECTOR_B, name: 'A/B' },
			connectorB,
		)
		const mutatedConnectorA = new RecordingConnector(CONNECTOR_A, ['bearer'])
		const mutatedConnectorAInstance = await manager.createInstance(
			TENANT_A,
			{ connectorId: CONNECTOR_A, name: 'A/A mutated view' },
			mutatedConnectorA,
		)
		;(tenantBInstance as unknown as { connectorId: ConnectorId }).connectorId = CONNECTOR_B
		;(tenantBInstance.config as { connectorId: ConnectorId }).connectorId = CONNECTOR_B
		;(mutatedConnectorAInstance as unknown as { connectorId: ConnectorId }).connectorId =
			CONNECTOR_B
		;(mutatedConnectorAInstance.config as { connectorId: ConnectorId }).connectorId = CONNECTOR_B

		await expect(
			manager.connectWithCredential(TENANT_B, tenantBInstance.id, ref.id),
		).rejects.toThrow(/unavailable for tenant "tnt_b" and connector "conn_a"/)
		await expect(
			manager.connectWithCredential(TENANT_A, connectorBInstance.id, ref.id),
		).rejects.toThrow(/unavailable for tenant "tnt_a" and connector "conn_b"/)
		await expect(
			manager.connectWithCredential(TENANT_A, mutatedConnectorAInstance.id, connectorBRef.id),
		).rejects.toThrow(/unavailable for tenant "tnt_a" and connector "conn_a"/)
		expect(tenantBInstance.config.auth).toBeUndefined()
		expect(connectorBInstance.config.auth).toBeUndefined()
		expect(tenantBConnector.connectCalls).toHaveLength(0)
		expect(connectorB.connectCalls).toHaveLength(0)
		expect(mutatedConnectorA.connectCalls).toHaveLength(0)

		expect(await manager.revokeCredential(TENANT_B, ref.id)).toBe(false)
		expect(await vault.inner.retrieveForScope(TENANT_A, CONNECTOR_A, ref.id)).toEqual(
			bearer('tenant-a-secret'),
		)

		const tenantAConnector = new RecordingConnector(CONNECTOR_A, ['bearer'])
		const tenantAInstance = await manager.createInstance(
			TENANT_A,
			{ connectorId: CONNECTOR_A, name: 'A/A' },
			tenantAConnector,
		)
		await manager.connectWithCredential(TENANT_A, tenantAInstance.id, ref.id)
		expect(tenantAConnector.connectCalls).toEqual([bearer('tenant-a-secret')])

		expect(await manager.revokeCredential(TENANT_A, ref.id)).toBe(true)
		expect(await vault.inner.retrieveForScope(TENANT_A, CONNECTOR_A, ref.id)).toBeUndefined()
		expect(vault.scopedRevokes).toEqual([
			[TENANT_B, ref.id],
			[TENANT_A, ref.id],
		])
	})

	it('skips stale/incompatible auto candidates and never calls unscoped lookup', async () => {
		const registry = new ConnectorRegistry()
		const definitionConnector = new RecordingConnector(CONNECTOR_A, ['bearer'])
		registry.register(definitionConnector.toDefinition())
		const vault = new ScopedOnlyVault()
		const incompatible = await vault.inner.store(TENANT_A, CONNECTOR_A, 'basic', {
			type: 'basic',
			credentials: { username: 'u', password: 'p' },
		})
		const stale = await vault.inner.store(TENANT_A, CONNECTOR_A, 'stale bearer', bearer('old'))
		await vault.inner.revoke(stale.id)
		const compatible = await vault.inner.store(TENANT_A, CONNECTOR_A, 'live bearer', bearer('live'))
		vault.listOverride = [incompatible, stale, compatible]

		const manager = new TenantConnectorManager({
			registry,
			credentialVault: vault,
		})
		manager.registerTenant({ id: TENANT_A, name: 'A' })
		const live = new RecordingConnector(CONNECTOR_A, ['bearer'])
		const instance = await manager.createInstance(
			TENANT_A,
			{ connectorId: CONNECTOR_A, name: 'auto' },
			live,
		)
		await manager.connect(TENANT_A, instance.id)

		expect(live.connectCalls).toEqual([bearer('live')])
		expect(vault.scopedLookups).toEqual([
			[TENANT_A, CONNECTOR_A, stale.id],
			[TENANT_A, CONNECTOR_A, compatible.id],
		])
		expect(vault.scopedLookups.flat()).not.toContain(incompatible.id)
	})

	it('refuses unsupported stored credentials before calling the vault', async () => {
		const registry = new ConnectorRegistry()
		registry.register(new RecordingConnector(CONNECTOR_A, ['bearer']).toDefinition())
		const vault = new ScopedOnlyVault()
		const manager = new TenantConnectorManager({
			registry,
			credentialVault: vault,
		})
		manager.registerTenant({ id: TENANT_A, name: 'A' })

		await expect(
			manager.storeCredential(TENANT_A, CONNECTOR_A, 'wrong', {
				type: 'basic',
				credentials: { username: 'u', password: 'p' },
			}),
		).rejects.toThrow(/does not support auth scheme "basic"/)
		expect(vault.storeCalls).toBe(0)

		const incompatible = await vault.inner.store(TENANT_A, CONNECTOR_A, 'pre-existing', {
			type: 'basic',
			credentials: { username: 'u', password: 'p' },
		})
		const connector = new RecordingConnector(CONNECTOR_A, ['bearer'])
		const instance = await manager.createInstance(
			TENANT_A,
			{ connectorId: CONNECTOR_A, name: 'explicit incompatible' },
			connector,
		)
		await expect(
			manager.connectWithCredential(TENANT_A, instance.id, incompatible.id),
		).rejects.toThrow(/does not support auth scheme "basic"/)
		expect(instance.config.auth).toBeUndefined()
		expect(connector.connectCalls).toHaveLength(0)
	})
})

describe('ConnectorManager auth admission', () => {
	it('treats an absent credential as none immediately before connect', async () => {
		const registry = new ConnectorRegistry()
		const connector = new RecordingConnector(CONNECTOR_A, ['bearer'])
		registry.register(connector.toDefinition())
		const manager = new ConnectorManager({ registry })
		const instance = await manager.createInstance(
			{ connectorId: CONNECTOR_A, name: 'late credential slot' },
			connector,
		)

		await expect(manager.connect(instance.id)).rejects.toThrow(
			/does not support auth scheme "none"/,
		)
		expect(connector.connectCalls).toHaveLength(0)
	})

	it('uses the snapshotted definition and refuses a late unsupported mutation', async () => {
		const registry = new ConnectorRegistry()
		const connector = new RecordingConnector(CONNECTOR_A, ['bearer'])
		registry.register(connector.toDefinition())
		const manager = new ConnectorManager({ registry })

		const instance = await manager.createInstance(
			{ connectorId: CONNECTOR_A, name: 'snapshotted', auth: bearer('ok') },
			connector,
		)
		registry.register({
			...connector.toDefinition(),
			supportedAuth: ['basic'],
		})
		instance.config.auth = {
			type: 'basic',
			credentials: { username: 'u', password: 'p' },
		}

		await expect(manager.connect(instance.id)).rejects.toThrow(
			/does not support auth scheme "basic"/,
		)
		expect(connector.connectCalls).toHaveLength(0)
	})

	it('refuses explicit unsupported auth and mismatched implementations before publication', async () => {
		const registry = new ConnectorRegistry()
		const connector = new RecordingConnector(CONNECTOR_A, ['bearer'])
		registry.register(connector.toDefinition())
		const manager = new ConnectorManager({ registry })

		await expect(
			manager.createInstance(
				{
					connectorId: CONNECTOR_A,
					name: 'wrong auth',
					auth: {
						type: 'basic',
						credentials: { username: 'u', password: 'p' },
					},
				},
				connector,
			),
		).rejects.toThrow(/does not support auth scheme "basic"/)
		await expect(
			manager.createInstance(
				{ connectorId: CONNECTOR_A, name: 'wrong implementation' },
				new RecordingConnector(CONNECTOR_B, ['bearer']),
			),
		).rejects.toThrow(/implementation id "conn_b" does not match requested definition "conn_a"/)
		await expect(
			manager.createInstance(
				{ connectorId: CONNECTOR_A, name: 'wrong same-id implementation' },
				new RecordingConnector(CONNECTOR_A, ['basic']),
			),
		).rejects.toThrow(/does not match its registered auth policy/)
		expect(manager.listInstances()).toHaveLength(0)
		expect(connector.connectCalls).toHaveLength(0)
	})

	it('drives the real Webhook declaration through manager admission', async () => {
		const connector = new WebhookConnector()
		const registry = new ConnectorRegistry()
		registry.register(connector.toDefinition())
		const manager = new ConnectorManager({ registry })

		expect(connector.toDefinition().supportedAuth).toEqual(['none', 'bearer'])
		await expect(
			manager.createInstance(
				{
					connectorId: connector.id,
					name: 'webhook',
					options: { url: 'https://example.com/hook' },
					auth: { type: 'api_key', credentials: { apiKey: 'secret' } },
				},
				connector,
			),
		).rejects.toThrow(/does not support auth scheme "api_key"/)
		expect(manager.listInstances()).toHaveLength(0)
	})
})
