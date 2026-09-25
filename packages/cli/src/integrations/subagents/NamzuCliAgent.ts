import { type AgentMetadata, type Logger, QueryAgent, type QueryAgentConfig } from '@namzu/sdk'

/** The CLI's delegated turn shell. The host owns its identity and configuration. */
export class NamzuCliAgent extends QueryAgent {
	override readonly type = 'namzu-cli' as const

	constructor(metadata: Omit<AgentMetadata, 'type' | 'capabilities'>, log?: Logger) {
		super({ ...metadata, type: 'namzu-cli' }, log)
	}
}

export type NamzuCliAgentConfig = QueryAgentConfig
