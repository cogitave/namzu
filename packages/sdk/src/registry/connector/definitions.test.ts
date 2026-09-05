/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 3):
 *
 *   - `ConnectorRegistry` extends `ManagedRegistry<ConnectorDefinition>`
 *     with `idField: 'id'` — it keys by the top-level `id` field, NOT
 *     a nested path.
 *   - `listByType(connectionType)` filters by `connectionType`.
 *   - As a global (non-tenant-scoped) registry, ConnectorRegistry is
 *     shared across tenants; tenant isolation lives in
 *     `TenantConnectorManager`.
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
		r.register(makeDef('0d14a2c3-cb4d-45f4-8784-65e346e4fa86', 'http'))
		expect(r.get('0d14a2c3-cb4d-45f4-8784-65e346e4fa86')).toBeDefined()
	})

	it('listByType filters by connectionType', () => {
		const r = new ConnectorRegistry()
		r.register(makeDef('0d14a2c3-cb4d-45f4-8784-65e346e4fa86', 'http'))
		r.register(makeDef('4f7cc074-39e0-4c26-b816-7c828a841542', 'webhook'))
		r.register(makeDef('1a14cb04-4e56-4ca0-8037-58872737029b', 'http'))
		expect(r.listByType('http').map((d) => d.id)).toEqual([
			'0d14a2c3-cb4d-45f4-8784-65e346e4fa86',
			'1a14cb04-4e56-4ca0-8037-58872737029b',
		])
		expect(r.listByType('webhook').map((d) => d.id)).toEqual([
			'4f7cc074-39e0-4c26-b816-7c828a841542',
		])
		expect(r.listByType('custom')).toEqual([])
	})
})
