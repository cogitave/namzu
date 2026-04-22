/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 3):
 *
 *   - `ConnectorRegistry` extends `ManagedRegistry<ConnectorDefinition>`
 *     with `idField: 'id'` — it keys by the top-level `id` field, NOT
 *     a nested path.
 *   - `listByType(connectionType)` filters by `connectionType`.
 *   - As a global (non-tenant-scoped) registry, ConnectorRegistry is
 *     shared across tenants; tenant isolation lives in
 *     `TenantConnectorManager` per Codex #5.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { ConnectorDefinition } from '../../types/connector/index.js'
import type { ConnectorId } from '../../types/ids/index.js'

import { ConnectorRegistry } from './definitions.js'

function makeDef(
	id: string,
	connectionType: ConnectorDefinition['connectionType'],
): ConnectorDefinition {
	return {
		id: id as ConnectorId,
		name: id,
		description: `${id} connector`,
		connectionType,
		configSchema: z.object({}),
		methods: [],
	}
}

describe('ConnectorRegistry', () => {
	it('keys by top-level id', () => {
		const r = new ConnectorRegistry()
		r.register(makeDef('conn_a', 'http'))
		expect(r.get('conn_a')).toBeDefined()
	})

	it('listByType filters by connectionType', () => {
		const r = new ConnectorRegistry()
		r.register(makeDef('conn_a', 'http'))
		r.register(makeDef('conn_b', 'webhook'))
		r.register(makeDef('conn_c', 'http'))
		expect(r.listByType('http').map((d) => d.id)).toEqual(['conn_a', 'conn_c'])
		expect(r.listByType('webhook').map((d) => d.id)).toEqual(['conn_b'])
		expect(r.listByType('custom')).toEqual([])
	})
})
