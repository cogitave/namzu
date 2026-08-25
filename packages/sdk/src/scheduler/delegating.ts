import { EMPTY_TOKEN_USAGE, ZERO_COST } from '../constants/limits.js'
import type { Delegate, DelegateRequest, DelegateResult } from '../types/agent/delegate.js'
import type { CreateTaskOptions, TaskHandle, TaskScheduler } from '../types/agent/scheduler.js'
import type { AgentTaskState } from '../types/agent/task.js'
import type { RunExecutionStatus } from '../types/common/index.js'
import type { TaskId } from '../types/ids/index.js'
import { type CancelCause, RunCancelled } from '../types/run/cancel-cause.js'
import { asRunId, generateTaskId } from '../utils/id.js'

/**
 * Presents a set of foreign delegates as a `TaskScheduler`.
 *
 * The two delegation tools, the completion inbox and the sibling-failure
 * policy all speak `TaskScheduler`, and none of them should have to learn
 * that a specialist moved out of process. So the seam is here rather than
 * in the tools: an id this knows about is dispatched to its `Delegate`, and
 * anything else falls through to the local scheduler untouched.
 *
 * **The mapping onto `TaskHandle` is the load-bearing part.** `taskSucceeded`
 * and `taskFailed` require the gateway state and the run status to AGREE,
 * because locally they are two independent authorities and a check reading
 * only one of them has already shipped a failed worker as an answer. A
 * foreign delegate has only its own word, so both fields are written from
 * that one answer — which keeps every existing predicate correct without
 * inventing a second authority that would only ever agree with the first.
 */

export interface DelegatingTaskSchedulerConfig {
	/**
	 * Where an id no delegate claims goes.
	 *
	 * Optional, and its absence is a real configuration: a host that
	 * delegates ONLY to foreign peers has no local scheduler to fall back
	 * to, and an unknown id there is a caller error rather than something to
	 * pass along.
	 */
	readonly local?: TaskScheduler
	readonly delegates: readonly Delegate[]
}

/** Two delegates, or a delegate and nothing, claiming one id. */
export class DelegateIdCollisionError extends Error {
	readonly details: { id: string }

	constructor(details: { id: string }) {
		super(`Two delegates are registered under the id "${details.id}".`)
		this.name = 'DelegateIdCollisionError'
		this.details = details
	}
}

/** A delegate whose declared capabilities do not match its methods. */
export class DelegateCapabilityMismatchError extends Error {
	readonly details: { id: string; capability: string }

	constructor(details: { id: string; capability: string }) {
		super(
			`Delegate "${details.id}" declares capabilities.${details.capability} but does not implement it.`,
		)
		this.name = 'DelegateCapabilityMismatchError'
		this.details = details
	}
}

/** An operation the delegate said it cannot do. */
export class DelegateCapabilityError extends Error {
	readonly details: { id: string; capability: string }

	constructor(details: { id: string; capability: string }) {
		super(`Delegate "${details.id}" does not support ${details.capability}.`)
		this.name = 'DelegateCapabilityError'
		this.details = details
	}
}

/** An agent id nothing can serve. */
export class NoDelegateError extends Error {
	readonly details: { agentId: string }

	constructor(details: { agentId: string }) {
		super(
			`No delegate is registered for "${details.agentId}", and this scheduler has no local fallback.`,
		)
		this.name = 'NoDelegateError'
		this.details = details
	}
}

/**
 * The two authorities a delegate's one answer is written onto.
 *
 * **Cancelled is not failed, and conflating them cancels a fan-out.**
 * `taskFailed` is `state === 'failed' || result.status === 'failed'`, and
 * `SiblingFailurePolicy: 'cancel-siblings'` acts on it — so writing
 * `status: 'failed'` for a delegation somebody deliberately stopped would
 * tear down every healthy sibling as a consequence of the stop. The first
 * draft here did exactly that, in the same commit as a comment saying it
 * must not.
 *
 * Note the spelling difference, which is the tree's and not a typo:
 * `AgentTaskState` has `'canceled'`, `RunExecutionStatus` has
 * `'cancelled'`. A table is what keeps that from being written from memory
 * at each site.
 */
const OUTCOME: Record<
	DelegateResult['status'],
	{ readonly state: AgentTaskState; readonly status: RunExecutionStatus }
> = {
	completed: { state: 'completed', status: 'completed' },
	failed: { state: 'failed', status: 'failed' },
	cancelled: { state: 'canceled', status: 'cancelled' },
}

interface Entry {
	handle: TaskHandle
	delegate: Delegate
	controller: AbortController
	settled: Promise<void>
}

export class DelegatingTaskScheduler implements TaskScheduler {
	private readonly byId = new Map<string, Delegate>()
	private readonly tasks = new Map<TaskId, Entry>()
	private readonly listeners = new Set<(handle: TaskHandle) => void>()

	constructor(private readonly config: DelegatingTaskSchedulerConfig) {
		for (const delegate of config.delegates) {
			if (this.byId.has(delegate.id)) {
				// Refused rather than resolved by precedence. A precedence rule
				// makes which delegate answers depend on registration order,
				// which is not visible at the call site that gets the wrong one.
				throw new DelegateIdCollisionError({ id: delegate.id })
			}
			if (delegate.capabilities.continue && typeof delegate.continue !== 'function') {
				// Checked at registration, not at the call. A capability that
				// claims a method the object does not have is a lie the caller
				// would otherwise find mid-delegation, with a worker running.
				throw new DelegateCapabilityMismatchError({ id: delegate.id, capability: 'continue' })
			}
			this.byId.set(delegate.id, delegate)
		}
	}

	/** The delegate serving this id, or `undefined` for the local path. */
	delegateFor(agentId: string): Delegate | undefined {
		return this.byId.get(agentId)
	}

	async createTask(options: CreateTaskOptions): Promise<TaskHandle> {
		const delegate = this.byId.get(options.agentId)
		if (!delegate) {
			if (!this.config.local) throw new NoDelegateError({ agentId: options.agentId })
			return await this.config.local.createTask(options)
		}

		const taskId = generateTaskId()
		const controller = new AbortController()
		const request: DelegateRequest = {
			prompt: options.prompt,
			workingDirectory: options.workingDirectory,
			...(options.runtimeContext ? { runtimeContext: options.runtimeContext } : {}),
			...(options.configOverrides?.env ? { env: options.configOverrides.env } : {}),
		}

		const entry: Entry = {
			handle: {
				taskId,
				agentId: options.agentId,
				state: 'running',
				createdAt: Date.now(),
			},
			delegate,
			controller,
			settled: Promise.resolve(),
		}
		this.tasks.set(taskId, entry)

		entry.settled = (async () => {
			let result: DelegateResult
			try {
				result = await delegate.dispatch(request, { signal: controller.signal })
			} catch (err) {
				// A delegate that threw failed; it did not vanish. Leaving the
				// handle `running` would have `waitForTask` hang forever on a
				// delegation that is already over.
				result = {
					status: 'failed',
					error: err instanceof Error ? err.message : String(err),
				}
			}
			entry.handle = this.settle(entry.handle, result)
			for (const listener of this.listeners) listener(entry.handle)
		})()

		return entry.handle
	}

	private settle(handle: TaskHandle, result: DelegateResult): TaskHandle {
		const outcome = OUTCOME[result.status]
		return {
			...handle,
			state: outcome.state,
			completedAt: Date.now(),
			result: {
				// A synthetic run record. The id names the task rather than
				// borrowing a run id that does not exist: a foreign delegate has
				// no run in this kernel, and minting a plausible-looking `run_`
				// would put an id in the transcript that nothing can resolve.
				runId: asRunId(`run_delegate_${handle.taskId}`),
				status: outcome.status,
				// Zero, and honestly so: this kernel did not spend these tokens
				// and has no way to learn what the delegate spent. `ZERO_COST`
				// carries no rate card for exactly this reason — a rate of zero
				// would read as "the model is free" rather than "nobody priced
				// this".
				usage: { ...EMPTY_TOKEN_USAGE },
				cost: { ...ZERO_COST },
				iterations: 0,
				durationMs: Date.now() - handle.createdAt,
				messages: [],
				...(result.output === undefined ? {} : { result: result.output }),
				...(result.error === undefined ? {} : { lastError: result.error }),
			},
		}
	}

	async waitForTask(taskId: TaskId): Promise<TaskHandle> {
		const entry = this.tasks.get(taskId)
		if (!entry) {
			if (!this.config.local) throw new Error(`No task ${taskId}.`)
			return await this.config.local.waitForTask(taskId)
		}
		await entry.settled
		return entry.handle
	}

	async continueTask(taskId: TaskId, message: string): Promise<void> {
		const entry = this.tasks.get(taskId)
		if (!entry) {
			if (!this.config.local) throw new Error(`No task ${taskId}.`)
			return await this.config.local.continueTask(taskId, message)
		}
		if (!entry.delegate.capabilities.continue || !entry.delegate.continue) {
			// Refused, not silently dropped. A no-op here has the parent
			// believe it steered a worker that never heard it — and it would
			// go on believing that until the answer came back unchanged.
			throw new DelegateCapabilityError({ id: entry.delegate.id, capability: 'continue' })
		}
		await entry.delegate.continue(message)
	}

	cancelTask(taskId: TaskId, cause?: CancelCause): void {
		const entry = this.tasks.get(taskId)
		if (!entry) {
			this.config.local?.cancelTask(taskId, cause)
			return
		}
		if (!entry.delegate.capabilities.cancel) {
			throw new DelegateCapabilityError({ id: entry.delegate.id, capability: 'cancel' })
		}
		controllerAbort(entry, cause)
	}

	getTask(taskId: TaskId): TaskHandle | undefined {
		return this.tasks.get(taskId)?.handle ?? this.config.local?.getTask(taskId)
	}

	listTasks(): TaskHandle[] {
		// Both, because a supervisor listing its children should not have to
		// know which of them happen to be foreign.
		return [
			...[...this.tasks.values()].map((e) => e.handle),
			...(this.config.local?.listTasks() ?? []),
		]
	}

	onTaskCompleted(callback: (handle: TaskHandle) => void): () => void {
		this.listeners.add(callback)
		const localOff = this.config.local?.onTaskCompleted(callback)
		return () => {
			this.listeners.delete(callback)
			localOff?.()
		}
	}
}

/**
 * Abort, and let the dispatch settle itself.
 *
 * Deliberately NOT writing the `canceled` state here. The delegate's own
 * `dispatch` is what resolves — with `cancelled`, or with an answer it had
 * already finished producing — and marking the handle from outside would
 * race that: a delegate that completed a microsecond before the abort would
 * be recorded as cancelled while its answer sat unread.
 */
function controllerAbort(entry: Entry, cause?: CancelCause): void {
	entry.controller.abort(cause ? new RunCancelled(cause) : undefined)
}
