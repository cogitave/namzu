import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BaseConnector } from '../../../connector/BaseConnector.js'
import { NAMZU } from '../../../constants/telemetry/index.js'
import { ConnectorRegistry } from '../../../registry/connector/definitions.js'
import type {
	ConnectionType,
	ConnectorExecuteResult,
	ConnectorMethod,
} from '../../../types/connector/index.js'
import type { ConnectorId, TenantId } from '../../../types/ids/index.js'
import type { LogContext, Logger } from '../../../utils/logger.js'
import { TenantConnectorManager } from '../tenant.js'

class TestConnector extends BaseConnector<Record<string, never>> {
	readonly id = 'conn_test' as ConnectorId
	readonly name = 'Test'
	readonly description = 'Test connector'
	readonly connectionType: ConnectionType = 'custom'
	readonly configSchema = z.object({})
	readonly methods: ConnectorMethod[] = []

	async connect(): Promise<void> {}
	async disconnect(): Promise<void> {}
	async healthCheck(): Promise<boolean> {
		return true
	}
	async execute(): Promise<ConnectorExecuteResult> {
		return { success: true, output: 'ok', durationMs: 0 }
	}
}

interface CapturedRecord {
	message: string
	bound: LogContext
}

/**
 * A minimal `Logger` that records every call site's ACCUMULATED `child()`
 * bindings alongside the message. `TenantConnectorManager` and
 * `ConnectorManager` hold the legacy `Logger` (debug/info/warn/error/child),
 * not the OTel-shaped `StructuredLogger` pipeline, so this is the honest
 * capture shape for them — no `LogSink`/`createLogger` involved.
 */
function capturingLogger(): { logger: Logger; records: CapturedRecord[] } {
	const records: CapturedRecord[] = []
	const make = (bound: LogContext): Logger => ({
		debug: (message) => records.push({ message, bound }),
		info: (message) => records.push({ message, bound }),
		warn: (message) => records.push({ message, bound }),
		error: (message) => records.push({ message, bound }),
		child: (context) => make({ ...bound, ...context }),
	})
	return { logger: make({}), records }
}

describe('TenantConnectorManager — per-tenant log correlation', () => {
	it('binds namzu.tenant.id per tenant, and no record from one tenant carries the other tenant’s id', async () => {
		const { logger, records } = capturingLogger()
		const registry = new ConnectorRegistry()
		registry.register({
			id: 'conn_test' as ConnectorId,
			name: 'Test',
			description: 'Test connector',
			connectionType: 'custom',
			configSchema: z.object({}),
			methods: [],
		})

		const manager = new TenantConnectorManager({ registry, log: logger })
		manager.registerTenant({ id: 't_a' as TenantId, name: 'Tenant A' })
		manager.registerTenant({ id: 't_b' as TenantId, name: 'Tenant B' })

		await manager.createInstance(
			't_a' as TenantId,
			{ connectorId: 'conn_test' as ConnectorId, name: 'a' },
			new TestConnector(),
		)
		await manager.createInstance(
			't_b' as TenantId,
			{ connectorId: 'conn_test' as ConnectorId, name: 'b' },
			new TestConnector(),
		)

		const creationRecords = records.filter((r) => r.message === 'Connector instance created')
		expect(creationRecords).toHaveLength(2)

		const aRecords = creationRecords.filter((r) => r.bound[NAMZU.TENANT_ID] === 't_a')
		const bRecords = creationRecords.filter((r) => r.bound[NAMZU.TENANT_ID] === 't_b')

		expect(aRecords).toHaveLength(1)
		expect(bRecords).toHaveLength(1)

		// Cross-tenant leakage fails this: nothing tenant A's manager wrote may
		// carry tenant B's id, and vice versa.
		for (const r of aRecords) expect(r.bound[NAMZU.TENANT_ID]).not.toBe('t_b')
		for (const r of bRecords) expect(r.bound[NAMZU.TENANT_ID]).not.toBe('t_a')
	})
})
