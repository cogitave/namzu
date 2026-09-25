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
import type { SessionEventListener } from '../types/session/events.js'

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
	/** The signal is scoped to this instance; observe it to stop work on cancel. */
	run(
		input: AgentInput,
		config: TConfig,
		listener: SessionEventListener | undefined,
		signal: AbortSignal,
	): Promise<TResult>
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
		// AgentManager asks for a fresh shell per delegated turn. Reusing one
		// controller would make a cancelled sibling abort another sibling's work.
		forTurn(): Agent<TConfig, TResult> {
			return defineAgent(options)
		},

		async run(
			input: AgentInput,
			config: TConfig,
			listener?: SessionEventListener,
		): Promise<TResult> {
			return options.run(input, config, listener, abortController.signal)
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
