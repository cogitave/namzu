import type { AgentManager } from '../manager/agent/lifecycle.js'
import type {
	Agent,
	AgentCapabilities,
	AgentInput,
	AgentMetadata,
	AgentType,
	BaseAgentConfig,
	BaseAgentResult,
} from '../types/agent/index.js'
import { EMPTY_TOKEN_USAGE } from '../types/common/index.js'
import type { RunId } from '../types/ids/index.js'
import type { RunEvent, RunEventListener } from '../types/run/index.js'
import { ZERO_COST } from '../utils/cost.js'
import { toErrorMessage } from '../utils/error.js'
import { generateRunId } from '../utils/id.js'
import { type Logger, getRootLogger } from '../utils/logger.js'

export abstract class AbstractAgent<
	TConfig extends BaseAgentConfig = BaseAgentConfig,
	TResult extends BaseAgentResult = BaseAgentResult,
> implements Agent<TConfig, TResult>
{
	abstract readonly type: AgentType
	readonly metadata: AgentMetadata
	protected log: Logger
	protected abortController: AbortController

	protected agentManager?: AgentManager

	protected currentRunId?: RunId

	constructor(metadata: AgentMetadata) {
		this.metadata = metadata
		this.abortController = new AbortController()
		this.log = getRootLogger().child({
			component: `Agent:${metadata.type}`,
			agentId: metadata.id,
		})
	}

	abstract run(input: AgentInput, config: TConfig, listener?: RunEventListener): Promise<TResult>

	async cancel(): Promise<void> {
		this.abortController.abort()

		if (this.agentManager && this.currentRunId) {
			this.agentManager.cancelAll(this.currentRunId)
		}
	}

	getCapabilities(): AgentCapabilities {
		return this.metadata.capabilities
	}

	protected createRunId(): RunId {
		return generateRunId()
	}

	protected createEmptyResult(runId: RunId, startTime: number): BaseAgentResult {
		return {
			runId,
			status: 'idle',
			usage: { ...EMPTY_TOKEN_USAGE },
			cost: { ...ZERO_COST },
			iterations: 0,
			durationMs: Date.now() - startTime,
			messages: [],
		}
	}

	protected async emitEvent(event: RunEvent, listener?: RunEventListener): Promise<void> {
		if (!listener) return
		try {
			await listener(event)
		} catch (err) {
			this.log.error('Event listener error', {
				error: toErrorMessage(err),
			})
		}
	}
}
