import { DEFAULT_CAPABILITIES } from '../constants/agent/index.js'
import type {
	Agent,
	AgentCapabilities,
	AgentInput,
	AgentMetadata,
	AgentType,
	BaseAgentConfig,
	BaseAgentResult,
} from '../types/agent/index.js'
import type { RunEventListener } from '../types/run/index.js'

export interface DefineAgentOptions<
	TConfig extends BaseAgentConfig = BaseAgentConfig,
	TResult extends BaseAgentResult = BaseAgentResult,
> {
	type: AgentType
	id: string
	name: string
	version: string
	category: string
	description: string
	capabilities?: Partial<AgentCapabilities>
	run(input: AgentInput, config: TConfig, listener?: RunEventListener): Promise<TResult>
	cancel?(): Promise<void>
}

export function defineAgent<
	TConfig extends BaseAgentConfig = BaseAgentConfig,
	TResult extends BaseAgentResult = BaseAgentResult,
>(options: DefineAgentOptions<TConfig, TResult>): Agent<TConfig, TResult> {
	const abortController = new AbortController()

	const metadata: AgentMetadata = {
		type: options.type,
		id: options.id,
		name: options.name,
		version: options.version,
		category: options.category,
		description: options.description,
		capabilities: { ...DEFAULT_CAPABILITIES, ...options.capabilities },
	}

	return {
		type: options.type,
		metadata,

		async run(input: AgentInput, config: TConfig, listener?: RunEventListener): Promise<TResult> {
			return options.run(input, config, listener)
		},

		async cancel(): Promise<void> {
			abortController.abort()
			if (options.cancel) {
				await options.cancel()
			}
		},

		getCapabilities(): AgentCapabilities {
			return metadata.capabilities
		},
	}
}
