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
	 * Cancelling waits for the children to be cancelled, including the ones that are
	 * parked: a child suspended on a durable decision is stopped by a write, not by a
	 * signal, and returning before that write lands would report a cancel that has not
	 * happened yet.
	 */
	async cancel(): Promise<void> {
		this.abortController.abort()

		if (this.agentManager && this.currentRunId) {
			await this.agentManager.cancelAll(this.currentRunId)
		}
	}

	/**
	 * Compose this agent's own {@link AbortController} with a caller-supplied
	 * `external` signal into a single signal to hand the run pipeline. The base
	 * owns the control (`cancel()` aborts `this.abortController`) AND its wiring:
	 * the query observes only the signal it is passed, so a subclass that forwards
	 * a raw `input.signal` orphans the internal controller and `cancel()` becomes
	 * a no-op on an in-flight run (ses_015 A6). Either source aborting — including
	 * one already aborted at entry — aborts the returned signal. `dispose()`
	 * removes the listeners and must be called in the run's `finally`.
	 */
	protected composeRunSignal(external?: AbortSignal): { signal: AbortSignal; dispose(): void } {
		const runAbort = new AbortController()
		const forward = (): void => runAbort.abort()

		if (this.abortController.signal.aborted || external?.aborted) {
			runAbort.abort()
			return { signal: runAbort.signal, dispose: () => {} }
		}

		this.abortController.signal.addEventListener('abort', forward, { once: true })
		external?.addEventListener('abort', forward, { once: true })

		return {
			signal: runAbort.signal,
			dispose: () => {
				this.abortController.signal.removeEventListener('abort', forward)
				external?.removeEventListener('abort', forward)
			},
		}
	}

	getCapabilities(): AgentCapabilities {
		return this.metadata.capabilities
	}

	/**
	 * Resolve the run id for one invocation: the caller's id if the config
	 * carries one, otherwise a freshly minted one. The base owns this because
	 * the base advertises the identity — an agent that minted its own inline
	 * silently renamed the caller's run, and the SSE mapper's substitution of
	 * its own `runId` argument hid the split from every client (ses_017 P3;
	 * one-canonical-name). Every agent MUST take its run id from here and
	 * thread it into `query()`; no agent calls `generateRunId()` itself.
	 */
	protected resolveRunId(config: BaseAgentConfig): RunId {
		return config.runId ?? generateRunId()
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
