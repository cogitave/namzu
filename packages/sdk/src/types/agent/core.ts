import type { RunEventListener } from '../run/index.js'
import type {
	AgentCapabilities,
	AgentInput,
	AgentMetadata,
	AgentType,
	BaseAgentConfig,
	BaseAgentResult,
} from './base.js'

export interface Agent<
	TConfig extends BaseAgentConfig = BaseAgentConfig,
	TResult extends BaseAgentResult = BaseAgentResult,
> {
	readonly type: AgentType
	readonly metadata: AgentMetadata

	run(input: AgentInput, config: TConfig, listener?: RunEventListener): Promise<TResult>

	cancel(): Promise<void>
	getCapabilities(): AgentCapabilities
}
