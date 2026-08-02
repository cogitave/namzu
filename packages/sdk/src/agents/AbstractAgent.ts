import { EMPTY_TOKEN_USAGE } from '../constants/limits.js'
import type {
	Agent,
	AgentCapabilities,
	AgentInput,
	AgentMetadata,
	AgentType,
	BaseAgentConfig,
	BaseAgentResult,
} from '../types/agent/index.js'
import type { AgentManagerContract } from '../types/agent/manager.js'
import type { RunId } from '../types/ids/index.js'
import type { RunEvent, RunEventListener } from '../types/run/index.js'
import { ZERO_COST } from '../utils/cost.js'
import { toErrorMessage } from '../utils/error.js'
import { generateRunId } from '../utils/id.js'
import { type Logger, getRootLogger } from '../utils/logger.js'
import { InvocationLock } from './lock.js'

export abstract class AbstractAgent<
	TConfig extends BaseAgentConfig = BaseAgentConfig,
	TResult extends BaseAgentResult = BaseAgentResult,
> implements Agent<TConfig, TResult>
{
	abstract readonly type: AgentType
	readonly metadata: AgentMetadata
	protected log: Logger
	protected abortController: AbortController
	private readonly invocationLock: InvocationLock

	protected agentManager?: AgentManagerContract

	protected currentRunId?: RunId

	constructor(metadata: AgentMetadata) {
		this.metadata = metadata
		this.abortController = new AbortController()
		this.invocationLock = new InvocationLock()
		this.log = getRootLogger().child({
			component: `Agent:${metadata.type}`,
			agentId: metadata.id,
		})
	}

	abstract run(input: AgentInput, config: TConfig, listener?: RunEventListener): Promise<TResult>

	/**
	 * Acquire the invocation lock to prevent concurrent execution.
	 * Returns a Disposable that must be disposed to release the lock.
	 *
	 * Usage:
	 * ```typescript
	 * const lock = this.acquireInvocationLock()
	 * try {
	 *   // do work
	 * } finally {
	 *   lock[Symbol.dispose]()
	 * }
	 * ```
	 *
	 * @throws {ConcurrentInvocationError} if the agent is already executing
	 */
	protected acquireInvocationLock() {
		return this.invocationLock.acquire(this.metadata.id)
	}

	/**
	 * Run `body` under this instance's invocation lock.
	 *
	 * The lock existed, was exported, and had no caller — so concurrent
	 * invocations of one agent instance were not prevented at all, and the
	 * error type that announces the refusal could never be thrown.
	 *
	 * They genuinely are unsafe. `abortController` and `currentRunId` are
	 * INSTANCE state: two overlapping runs share one abort controller, so
	 * cancelling either kills both, and the second clobbers the first's run
	 * id, so `cancel()` afterwards cancels the wrong run. Neither failure
	 * announces itself — the first run simply stops, or the wrong one does.
	 *
	 * A host that wants parallelism constructs a second instance, which is
	 * cheap; sharing one was never the supported shape, it merely was not
	 * refused.
	 */
	protected async underInvocationLock<T>(body: () => Promise<T>): Promise<T> {
		const lock = this.acquireInvocationLock()
		try {
			return await body()
		} finally {
			lock[Symbol.dispose]()
		}
	}

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
