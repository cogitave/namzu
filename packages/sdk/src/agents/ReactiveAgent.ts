import type { AgentMetadata } from '../types/agent/index.js'
import type { Logger } from '../utils/logger.js'
import { QueryAgent } from './QueryAgent.js'

/** @deprecated Use QueryAgent for a generic query turn or define an application agent. */
export class ReactiveAgent extends QueryAgent {
	override readonly type = 'reactive' as const

	constructor(metadata: Omit<AgentMetadata, 'type' | 'capabilities'>, log?: Logger) {
		super({ ...metadata, type: 'reactive' }, log)
	}
}
