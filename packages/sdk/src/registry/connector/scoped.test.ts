/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 3):
 *
 *   - `ScopedConnectorRegistry` stores per-scope config by a composite
 *     key `<scope>:<scopeId>:<connectorId>`. Multiple configs at
 *     different scopes for the same connector coexist.
 *   - `set`, `remove`, `getAt` round-trip through the same key.
 *   - `resolve(connectorId, chain)` iterates in `CONNECTOR_SCOPE_ORDER`
 *     (org → environment → team → project → agent) and merges layers
 *     — later scopes override earlier ones. Specifically:
 *     - `options` are shallow-merged across layers.
 *     - `auth` is last-wins (any layer with an explicit auth replaces).
 *     - `enabled` is last-wins (defaulting to true when no layer sets it).
 *     - The final `ConnectorConfig.name` falls back to `connectorId`
 *       when no layer sets a name.
 *   - `resolve` returns undefined when no layer matches the chain.
 *   - `listForConnector` returns every config for a connector across
 *     all scopes; `listAtScope` returns every connector at a given scope.
 */

import { describe, expect, it } from 'vitest'

import type { ConnectorId } from '../../types/ids/index.js'

import { ScopedConnectorRegistry } from './scoped.js'

const CID = 'conn_http' as ConnectorId

describe('ScopedConnectorRegistry', () => {
	describe('set + getAt + remove', () => {
		it('round-trips via the composite key', () => {
			const r = new ScopedConnectorRegistry()
			r.set({
				scope: { scope: 'org', scopeId: 'org_1' },
				connectorId: CID,
				options: { k: 'v' },
			})
			expect(r.getAt({ scope: 'org', scopeId: 'org_1' }, CID)?.options).toEqual({ k: 'v' })
		})

		it('remove returns true iff an entry existed', () => {
			const r = new ScopedConnectorRegistry()
			r.set({ scope: { scope: 'org', scopeId: 'org_1' }, connectorId: CID })
			expect(r.remove({ scope: 'org', scopeId: 'org_1' }, CID)).toBe(true)
			expect(r.remove({ scope: 'org', scopeId: 'org_1' }, CID)).toBe(false)
		})

		it('different scopes coexist for the same connector', () => {
			const r = new ScopedConnectorRegistry()
			r.set({ scope: { scope: 'org', scopeId: 'org_1' }, connectorId: CID })
			r.set({ scope: { scope: 'project', scopeId: 'proj_1' }, connectorId: CID })
			expect(r.listForConnector(CID)).toHaveLength(2)
		})
	})

	describe('resolve layering', () => {
		it('merges options shallow; later scopes override', () => {
			const r = new ScopedConnectorRegistry()
			r.set({
				scope: { scope: 'org', scopeId: 'org_1' },
				connectorId: CID,
				options: { host: 'api.org', timeout: 30 },
			})
			r.set({
				scope: { scope: 'project', scopeId: 'proj_1' },
				connectorId: CID,
				options: { host: 'api.project' },
			})
			const resolved = r.resolve(CID, { org: 'org_1', project: 'proj_1' })
			expect(resolved?.options).toEqual({ host: 'api.project', timeout: 30 })
		})

		it('auth is last-wins (CONNECTOR_SCOPE_ORDER)', () => {
			const r = new ScopedConnectorRegistry()
			r.set({
				scope: { scope: 'org', scopeId: 'org_1' },
				connectorId: CID,
				auth: { type: 'none' },
			})
			r.set({
				scope: { scope: 'project', scopeId: 'proj_1' },
				connectorId: CID,
				auth: { type: 'api_key', credentials: { apiKey: 'secret' } },
			})
			const resolved = r.resolve(CID, { org: 'org_1', project: 'proj_1' })
			expect(resolved?.auth).toEqual({ type: 'api_key', credentials: { apiKey: 'secret' } })
		})

		it('enabled defaults to true and is last-wins', () => {
			const r = new ScopedConnectorRegistry()
			r.set({ scope: { scope: 'org', scopeId: 'org_1' }, connectorId: CID, enabled: false })
			const resolved = r.resolve(CID, { org: 'org_1' })
			expect(resolved?.enabled).toBe(false)
		})

		it('config.name falls back to connectorId when no layer sets a name', () => {
			const r = new ScopedConnectorRegistry()
			r.set({ scope: { scope: 'org', scopeId: 'org_1' }, connectorId: CID })
			const resolved = r.resolve(CID, { org: 'org_1' })
			expect(resolved?.config.name).toBe(CID)
		})

		it('resolvedFrom preserves layer order by CONNECTOR_SCOPE_ORDER', () => {
			const r = new ScopedConnectorRegistry()
			r.set({ scope: { scope: 'project', scopeId: 'proj_1' }, connectorId: CID })
			r.set({ scope: { scope: 'org', scopeId: 'org_1' }, connectorId: CID })
			const resolved = r.resolve(CID, { org: 'org_1', project: 'proj_1' })
			expect(resolved?.resolvedFrom.map((s) => s.scope)).toEqual(['org', 'project'])
		})

		it('returns undefined when no layer matches the chain', () => {
			const r = new ScopedConnectorRegistry()
			expect(r.resolve(CID, { org: 'org_none' })).toBeUndefined()
		})
	})

	describe('list operations', () => {
		it('listAtScope filters by scope prefix', () => {
			const r = new ScopedConnectorRegistry()
			r.set({ scope: { scope: 'org', scopeId: 'org_1' }, connectorId: CID })
			r.set({
				scope: { scope: 'org', scopeId: 'org_1' },
				connectorId: 'conn_other' as ConnectorId,
			})
			r.set({ scope: { scope: 'project', scopeId: 'proj_1' }, connectorId: CID })
			expect(r.listAtScope({ scope: 'org', scopeId: 'org_1' })).toHaveLength(2)
		})
	})
})
