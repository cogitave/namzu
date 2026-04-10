import type { PluginDefinition, PluginScope, PluginStatus } from '../../types/plugin/index.js'
import { ManagedRegistry } from '../ManagedRegistry.js'

export class PluginRegistry extends ManagedRegistry<PluginDefinition> {
	constructor() {
		super({ componentName: 'PluginRegistry', idField: 'id' })
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
