import type { ConnectorDefinition } from '../../types/connector/index.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'
import { Registry } from '../Registry.js'

export class ConnectorRegistry extends Registry<ConnectorDefinition> {
	private log: Logger

	constructor() {
		super()
		this.log = getRootLogger().child({ component: 'ConnectorRegistry' })
	}

	override register(id: string, definition: ConnectorDefinition): void
	override register(definition: ConnectorDefinition): void
	override register(definitions: ConnectorDefinition[]): void
	override register(
		idOrDef: string | ConnectorDefinition | ConnectorDefinition[],
		maybeDef?: ConnectorDefinition,
	): void {
		if (Array.isArray(idOrDef)) {
			for (const def of idOrDef) {
				this.register(def)
			}
			return
		}

		const def = typeof idOrDef === 'string' ? maybeDef! : idOrDef
		const id = typeof idOrDef === 'string' ? idOrDef : def.id

		if (this.has(id)) {
			this.log.warn(`Connector "${id}" is already registered, overwriting.`)
		}
		super.register(id, def)
		this.log.info(`Connector registered: ${id}`)
	}

	getOrThrow(id: string): ConnectorDefinition {
		const def = this.get(id)
		if (!def) {
			throw new Error(`Connector not found: "${id}". Available: ${this.listIds().join(', ')}`)
		}
		return def
	}

	listByType(connectionType: ConnectorDefinition['connectionType']): ConnectorDefinition[] {
		return this.getAll().filter((d) => d.connectionType === connectionType)
	}
}
