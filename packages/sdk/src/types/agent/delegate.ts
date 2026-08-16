import type { AgentRuntimeContext } from './base.js'

/**
 * A delegate that need not be an in-process Namzu agent.
 *
 * Delegation was reachable exactly one way: `TaskScheduler.createTask` with
 * an `agentId` the host's `AgentManager` could resolve. Every delegate was
 * therefore a Namzu agent, in this process, built from this kernel's own
 * definition — so a host with a specialist behind an A2A card, an ACP
 * connection, or any service at all had nowhere to put it except by
 * implementing the whole `TaskScheduler` surface, most of which is about
 * bookkeeping the kernel already does.
 *
 * This is the surface a foreign delegate actually has to provide: take a
 * prompt, return an outcome, and say whether it can be cancelled or
 * continued. `DelegatingTaskScheduler` presents any set of these as a
 * `TaskScheduler`, so the two delegation tools and everything else that
 * speaks to a scheduler are unchanged.
 *
 * **The roster is still enforced upstream.** The delegation tools check
 * `allowedAgentIds` before an id reaches any scheduler, so registering a
 * delegate here does not by itself make it reachable — the same complete
 * mediation the tools already document.
 */

export interface DelegateRequest {
	/** What the delegate is being asked to do. */
	readonly prompt: string
	/** The parent's working directory, for a delegate that shares a disk. */
	readonly workingDirectory: string
	readonly runtimeContext?: AgentRuntimeContext
	/**
	 * The parent's resolved environment.
	 *
	 * Forwarded for the reason the `Agent` tool gives for forwarding it to a
	 * local child: a delegate that cannot see it runs against different
	 * services than the run that launched it, silently. A remote delegate
	 * may well ignore it, which is its business.
	 */
	readonly env?: Readonly<Record<string, string>>
}

/**
 * What a delegate did.
 *
 * `status` is the delegate's own answer and is the only authority a foreign
 * delegate has — there is no second layer to cross-check it against the way
 * a local run's `TaskHandle.state` and `BaseAgentResult.status` check each
 * other. `DelegatingTaskScheduler` maps this onto BOTH so that
 * `taskSucceeded` and `taskFailed` keep working unchanged; that mapping is
 * the whole reason this type is this small.
 */
export interface DelegateResult {
	readonly status: 'completed' | 'failed' | 'cancelled'
	/** The answer, when there is one. */
	readonly output?: string
	/** Why it failed, in the delegate's own words. */
	readonly error?: string
}

/**
 * What a delegate can do beyond answering once.
 *
 * Declared rather than assumed, and a `false` here is REFUSED at the call
 * rather than quietly no-op'd. A `continueTask` that silently did nothing
 * would have the parent believe it steered a worker that never heard it.
 */
export interface DelegateCapabilities {
	/** Can a running delegation be cancelled? */
	readonly cancel: boolean
	/** Can a message be sent to a delegation already in flight? */
	readonly continue: boolean
}

export interface Delegate {
	/**
	 * The id the delegation tools name.
	 *
	 * Shares a namespace with local agent ids on purpose: a supervisor
	 * should not have to know whether the specialist it is calling is in
	 * this process, and moving one from local to remote should not rewrite
	 * every caller. The collision that follows is refused loudly at
	 * registration rather than resolved by precedence.
	 */
	readonly id: string

	readonly capabilities: DelegateCapabilities

	/**
	 * Run the delegation to completion.
	 *
	 * `signal` fires when the delegation is cancelled. A delegate declaring
	 * `capabilities.cancel` must honour it; one that does not will never be
	 * handed a signal that fires, because the scheduler refuses the cancel
	 * before it gets that far.
	 */
	dispatch(
		request: DelegateRequest,
		opts: { readonly signal?: AbortSignal },
	): Promise<DelegateResult>

	/**
	 * Deliver a message to a delegation in flight.
	 *
	 * Present only when `capabilities.continue` is true. The two are checked
	 * against each other at registration, because a capability that claims a
	 * method the object does not have is a lie the caller finds at runtime.
	 */
	continue?(message: string): Promise<void>
}
