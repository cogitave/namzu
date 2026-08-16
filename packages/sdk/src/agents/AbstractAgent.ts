import { EMPTY_TOKEN_USAGE } from '../constants/limits.js'
import { GENAI, NAMZU } from '../constants/telemetry/index.js'
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
import { type CancelCause, RunCancelled } from '../types/run/cancel-cause.js'
import type { RunEvent, RunEventListener } from '../types/run/index.js'
import { ZERO_COST } from '../utils/cost.js'
import { toErrorMessage } from '../utils/error.js'
import { generateRunId } from '../utils/id.js'
import { SCOPE_ATTRIBUTE } from '../utils/log/types.js'
import { type Logger, resolveLogger } from '../utils/logger.js'
import { InvocationLock } from './lock.js'

export abstract class AbstractAgent<
	TConfig extends BaseAgentConfig = BaseAgentConfig,
	TResult extends BaseAgentResult = BaseAgentResult,
> implements Agent<TConfig, TResult>
{
	abstract readonly type: AgentType
	readonly metadata: AgentMetadata
	protected log: Logger
	/**
	 * The logger bound at construction, before any run id exists. `this.log`
	 * is rebound to a CHILD of this on every `bindRun` call — never the other
	 * way — so `forRun()` (which builds a fresh shell from `this.metadata`)
	 * can hand the new instance the same base identity without also handing
	 * it a stale run id from whichever run happened to be live last.
	 */
	private readonly baseLog: Logger
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

	constructor(metadata: AgentMetadata, log?: Logger) {
		this.metadata = metadata
		this.abortController = new AbortController()
		this.invocationLock = new InvocationLock()
		this.baseLog = resolveLogger(log).child({
			[SCOPE_ATTRIBUTE]: 'agents',
			[NAMZU.AGENT_TYPE]: metadata.type,
			[GENAI.AGENT_ID]: metadata.id,
		})
		this.log = this.baseLog
	}

	abstract run(input: AgentInput, config: TConfig, listener?: RunEventListener): Promise<TResult>

	/**
	 * A fresh shell of this agent, for a run that must not share one.
	 *
	 * See {@link Agent.forRun}. An agent is a shell around metadata — every
	 * per-run decision arrives in `config` and `input` — so a second instance
	 * costs one object and gives the run its own abort controller and run id,
	 * which is precisely what the invocation lock is protecting.
	 *
	 * Rebuilt from `this.constructor` and `this.metadata`, which covers every
	 * agent in this package: they all take metadata and nothing else. A
	 * subclass with a different constructor signature will throw here, and the
	 * answer to that is `this` — the caller then shares the shell and gets the
	 * existing refusal on a concurrent run, which is the behaviour before this
	 * existed. Losing parallelism is a worse outcome than not having it; losing
	 * the run is not on the table.
	 *
	 * A host whose agent needs real construction arguments supplies
	 * `AgentDefinition.createAgent` instead, which wins over this.
	 */
	forRun(): this {
		try {
			const Ctor = this.constructor as unknown as new (
				metadata: AgentMetadata,
				log?: Logger,
			) => this
			return new Ctor(this.metadata, this.baseLog)
		} catch (err) {
			this.log.warn(
				'Could not build a per-run shell; concurrent runs of this agent will still be refused',
				{
					[GENAI.AGENT_ID]: this.metadata.id,
					'exception.message': err instanceof Error ? err.message : String(err),
				},
			)
			return this
		}
	}

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
				[GENAI.AGENT_ID]: this.metadata.id,
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

	/**
	 * `cause` is optional and has no default, deliberately. An operator
	 * calling this IS the `'user'` case, but a library calling it on the
	 * operator's behalf is not — and a default would attribute every
	 * unlabelled cancellation to a person who did not press anything.
	 *
	 * Children get `'parent'` regardless of what stopped this run: from a
	 * child's side, the fact is that its parent went away.
	 */
	async cancel(cause?: CancelCause): Promise<void> {
		this.abortController.abort(cause ? new RunCancelled(cause) : undefined)

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

	/**
	 * Rebind this instance's logger to a specific run, so every record
	 * `this.log` writes for the DURATION of that run carries `namzu.run.id` —
	 * and every record after the NEXT call carries that run's id, not this
	 * one.
	 *
	 * Constructor-time binding was the bug this exists to fix: an agent
	 * constructed once and invoked twice (`forRun` aside — a host is free to
	 * reuse one instance across sequential runs, and every concrete `run()`
	 * takes fresh `input`/`config` precisely to allow it) held ONE logger for
	 * its whole lifetime, so a warning from run two carried run one's id, or
	 * none. Every concrete `run()` implementation calls this before touching
	 * `this.log`, right after resolving the run's id — see `RouterAgent`,
	 * `PipelineAgent`, `SupervisorAgent` and `ReactiveAgent`.
	 *
	 * `log` lets a per-run override (`BaseAgentConfig.logger`, a host setting
	 * on ONE call to `.run()`) win over the agent's construction-time base,
	 * without reconstructing the agent to get it.
	 *
	 * Also the one place `currentRunId` is actually assigned. It was declared
	 * and read by `cancel()` but never written — a run could never be
	 * cancelled by id because nothing ever recorded which run was current.
	 */
	protected bindRun(runId: RunId, log?: Logger): void {
		this.currentRunId = runId
		this.log = (log ?? this.baseLog).child({ [NAMZU.RUN_ID]: runId })
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
				'exception.message': toErrorMessage(err),
			})
		}
	}
}
