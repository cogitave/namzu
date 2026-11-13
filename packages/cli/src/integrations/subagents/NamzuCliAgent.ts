import { type AgentMetadata, type Logger, QueryAgent, type QueryAgentConfig } from '@namzu/sdk'

/**
 * What a run does around itself: called when the run starts with the child's
 * session id, and the function it returns is called when the run ends, however
 * it ends. It may throw, and then the run does not start.
 */
export type RunScope = (sessionId: string) => () => void

/** The CLI's delegated turn shell. The host owns its identity and configuration. */
export class NamzuCliAgent extends QueryAgent {
	override readonly type = 'namzu-cli' as const

	constructor(
		metadata: Omit<AgentMetadata, 'type' | 'capabilities'>,
		log?: Logger,
		private readonly scope?: RunScope,
	) {
		super({ ...metadata, type: 'namzu-cli' }, log)
	}

	override async run(...args: Parameters<QueryAgent['run']>): ReturnType<QueryAgent['run']> {
		const [input, config] = args
		const sessionId = input.managedScope?.sessionId ?? config.sessionId
		if (!this.scope || sessionId === undefined) return super.run(...args)
		const end = this.scope(String(sessionId))
		try {
			return await super.run(...args)
		} finally {
			end()
		}
	}
}

export type NamzuCliAgentConfig = QueryAgentConfig
