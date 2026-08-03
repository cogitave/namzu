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

	/**
	 * Invocations still running, by the key their caller supplied.
	 *
	 * IN-FLIGHT ONLY, and deliberately: a settled entry kept around would
	 * turn deduplication into caching, and caching an agent's answer is a
	 * decision about staleness that only the host can make. A retry that
	 * arrives after the first finished runs again, which is the honest
	 * behaviour — the world may have moved.
	 */
	private readonly inflightByKey = new Map<string, Promise<unknown>>()

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

	/**
	 * Join an invocation already running under the same key, instead of
	 * starting a second one.
	 *
	 * The failure this exists for: a caller sends a request, the connection
	 * drops, the caller retries. Without a key the retry is a second full
	 * run — a second set of model calls, and a second set of whatever the
	 * tools did. The invocation lock alone does not help, because refusing
	 * the retry with an error is not what the caller wanted either; they
	 * wanted the answer.
	 *
	 * So a duplicate AWAITS the original and receives its result, error
	 * included. An error is shared for the same reason a result is: both
	 * callers asked the same question once, and telling one of them
	 * something different would make the key a lie.
	 *
	 * Instance-scoped, like the lock. Deduplicating across processes needs
	 * somewhere durable to record the key, which is a store the host owns.
	 */
	protected async underIdempotencyKey<T>(
		key: string | undefined,
		body: () => Promise<T>,
	): Promise<T> {
		if (key === undefined || key === '') return body()

		const inflight = this.inflightByKey.get(key)
		if (inflight) {
			this.log.info('Joining an invocation already running under this key', {
				agentId: this.metadata.id,
				idempotencyKey: key,
			})
			return inflight as Promise<T>
		}

		const started = body()
		this.inflightByKey.set(key, started)
		try {
			return await started
		} finally {
			// Cleared on settle, success or failure: keeping it would make the
			// next retry a cache read rather than a fresh run.
			this.inflightByKey.delete(key)
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
