import type { PluginDefinition, PluginScope, PluginStatus } from '../../types/plugin/index.js'
import { ManagedRegistry } from '../ManagedRegistry.js'

export class PluginRegistry extends ManagedRegistry<PluginDefinition> {
	constructor() {
		super({
			componentName: 'PluginRegistry',
			idField: 'id',
			// A public projection a host is meant to be able to overwrite —
			// `PluginLifecycleManager` itself re-registers the same id under
			// a new status on every enable/disable/error transition, and a
			// host may write its own record here directly (executable
			// contribution ownership, not this registry, is the lifecycle's
			// real guard against a forged status — see `enable()`'s comment
			// in `plugin/lifecycle.ts`). `ManagedRegistry`'s own default is
			// `'throw'` now (see `registry/collision.ts`); this registry is
			// one of the named exceptions.
			onCollision: 'warn-overwrite',
		})
	}

	listByScope(scope: PluginScope): PluginDefinition[] {
		return this.getAll().filter((def) => def.scope === scope)
	}

	listByStatus(status: PluginStatus): PluginDefinition[] {
		return this.getAll().filter((def) => def.status === status)
	}

	findByName(name: string): PluginDefinition | undefined {
		return this.getAll().find((def) => def.manifest.name === name)
	}
}
