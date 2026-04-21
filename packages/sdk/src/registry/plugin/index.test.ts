/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 3):
 *
 *   - `PluginRegistry` extends `ManagedRegistry<PluginDefinition>`
 *     with `idField: 'id'`.
 *   - `listByScope(scope)` filters by `def.scope`.
 *   - `listByStatus(status)` filters by `def.status`.
 *   - `findByName(name)` does a linear scan through `getAll()` and
 *     returns the first match by `manifest.name`, or undefined.
 */

import { describe, expect, it } from 'vitest'

import type { PluginId } from '../../types/ids/index.js'
import type { PluginDefinition, PluginScope, PluginStatus } from '../../types/plugin/index.js'

import { PluginRegistry } from './index.js'

function makeDef(
	id: string,
	scope: PluginScope,
	status: PluginStatus,
	name = id,
): PluginDefinition {
	return {
		id: id as PluginId,
		manifest: {
			name,
			version: '1.0.0',
			description: `${name} plugin`,
		},
		scope,
		status,
		rootDir: `/plugins/${id}`,
		installedAt: Date.now(),
	}
}

describe('PluginRegistry', () => {
	it('keys by top-level id', () => {
		const r = new PluginRegistry()
		r.register(makeDef('plugin_a', 'project', 'installed'))
		expect(r.get('plugin_a')).toBeDefined()
	})

	it('listByScope filters by scope', () => {
		const r = new PluginRegistry()
		r.register(makeDef('a', 'project', 'installed'))
		r.register(makeDef('b', 'user', 'enabled'))
		r.register(makeDef('c', 'project', 'disabled'))
		expect(r.listByScope('project').map((d) => d.id)).toEqual(['a', 'c'])
		expect(r.listByScope('user').map((d) => d.id)).toEqual(['b'])
	})

	it('listByStatus filters by status', () => {
		const r = new PluginRegistry()
		r.register(makeDef('a', 'project', 'installed'))
		r.register(makeDef('b', 'project', 'enabled'))
		r.register(makeDef('c', 'project', 'enabled'))
		expect(r.listByStatus('enabled').map((d) => d.id)).toEqual(['b', 'c'])
		expect(r.listByStatus('error')).toEqual([])
	})

	describe('findByName', () => {
		it('returns the first def with matching manifest.name', () => {
			const r = new PluginRegistry()
			r.register(makeDef('id_1', 'project', 'installed', 'alpha'))
			r.register(makeDef('id_2', 'project', 'installed', 'beta'))
			expect(r.findByName('beta')?.id).toBe('id_2')
		})

		it('returns undefined when no match', () => {
			const r = new PluginRegistry()
			r.register(makeDef('id_1', 'project', 'installed', 'alpha'))
			expect(r.findByName('missing')).toBeUndefined()
		})

		it('is case-sensitive (exact string match)', () => {
			const r = new PluginRegistry()
			r.register(makeDef('id_1', 'project', 'installed', 'Alpha'))
			expect(r.findByName('alpha')).toBeUndefined()
			expect(r.findByName('Alpha')?.id).toBe('id_1')
		})
	})
})
