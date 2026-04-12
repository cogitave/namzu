import type { AgentType, BaseAgentConfig, BaseAgentResult } from '../../types/agent/base.js'
import type { Agent } from '../../types/agent/core.js'
import type { AgentDefinition } from '../../types/agent/factory.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'
import { Registry } from '../Registry.js'

export class AgentRegistry extends Registry<AgentDefinition> {
	private log: Logger

	constructor() {
		super()
		this.log = getRootLogger().child({ component: 'AgentRegistry' })
	}

	override register(id: string, definition: AgentDefinition): void
	override register(definition: AgentDefinition): void
	override register(definitions: AgentDefinition[]): void
	override register(
		idOrDef: string | AgentDefinition | AgentDefinition[],
		maybeDef?: AgentDefinition,
	): void {
		if (Array.isArray(idOrDef)) {
			for (const def of idOrDef) {
				this.register(def)
			}
			return
		}

		if (typeof idOrDef === 'string') {
			if (!maybeDef) {
				throw new Error('register(id, definition) requires a definition argument')
			}
			const id = idOrDef
			const def = maybeDef
			if (this.has(id)) {
				this.log.warn(`Agent "${id}" already registered, overwriting.`)
			}
			super.register(id, def)
			this.log.info(`Agent registered: ${id}`)
			return
		}

		const def = idOrDef
		const id = def.info.id

		if (this.has(id)) {
			this.log.warn(`Agent "${id}" already registered, overwriting.`)
		}
		super.register(id, def)
		this.log.info(`Agent registered: ${id}`)
	}

	getOrThrow(id: string): AgentDefinition {
		const def = this.get(id)
		if (!def) {
			throw new Error(`Agent not found: "${id}". Available: ${this.listIds().join(', ')}`)
		}
		return def
	}

	resolve(agentId: string): Agent<BaseAgentConfig, BaseAgentResult> {
		return this.getOrThrow(agentId).typedAgent
	}

	listByType(type: AgentType): AgentDefinition[] {
		return this.getAll().filter((d) => d.typedAgent.type === type)
	}

	search(query: { category?: string; query?: string }): AgentDefinition[] {
		return this.getAll().filter((def) => {
			if (query.category && def.info.category !== query.category) return false
			if (query.query) {
				const q = query.query.toLowerCase()
				if (
					!def.info.name.toLowerCase().includes(q) &&
					!def.info.description.toLowerCase().includes(q)
				)
					return false
			}
			return true
		})
	}
}
