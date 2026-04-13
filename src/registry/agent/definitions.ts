import type { AgentType, BaseAgentConfig, BaseAgentResult } from '../../types/agent/base.js'
import type { Agent } from '../../types/agent/core.js'
import type { AgentDefinition } from '../../types/agent/factory.js'
import { ManagedRegistry } from '../ManagedRegistry.js'

export class AgentRegistry extends ManagedRegistry<AgentDefinition> {
	constructor() {
		super({ componentName: 'AgentRegistry', computeId: (def) => def.info.id })
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
