import type { ConnectorDefinition } from '../../types/connector/index.js'
import { ManagedRegistry } from '../ManagedRegistry.js'

export class ConnectorRegistry extends ManagedRegistry<ConnectorDefinition> {
	constructor() {
		super({ componentName: 'ConnectorRegistry', idField: 'id' })
	}

	listByType(connectionType: ConnectorDefinition['connectionType']): ConnectorDefinition[] {
		return this.getAll().filter((d) => d.connectionType === connectionType)
	}
}
