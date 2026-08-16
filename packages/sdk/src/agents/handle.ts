import type { SteeringChannel } from '../runtime/query/steering.js'
import type { TopicStateStore } from '../store/topic/state.js'
import { NamzuError } from '../types/errors/index.js'
import type { TenantId, TopicId } from '../types/ids/index.js'
import type { Message } from '../types/message/index.js'

/**
 * The object a host holds between runs.
 *
 * There was none. A host could not ask whether the agent was running, and
 * had nowhere to put "when you next run, start with this" — so it either
 * held a steer until it observed a run starting, or carried the text itself
 * and passed it manually on the next `run()` call.
 *
 * Two delivery targets, each with a stated lifetime, and no silent third
 * state. `steer` reaches the run that is happening; `queueForNextRun`
 * reaches the one that has not started. `steer` on an idle handle THROWS
 * rather than accepting into a queue nothing will read — that refusal is
 * the design, because the alternative is a host believing it redirected an
 * agent that was not listening.
 */

/**
 * Whether a run is in flight, as this handle sees it.
 *
 * NOT `AgentStatus` — that name is taken by a deprecated alias of
 * `RunExecutionStatus` whose own test records that it never typed an agent
 * and is being removed in the next major. Reusing it here would silently
 * change what a consumer's `AgentStatus` MEANS rather than failing their
 * build, which is the worse of the two outcomes and the one a deprecation
 * window exists to avoid.
 */
export type AgentHandleStatus = 'idle' | 'running'

/** A steer aimed at an agent that is not running. */
export class AgentNotRunningError extends NamzuError {
	constructor() {
		super({
			code: 'invalid_config',
			message:
				'steer() needs a run in flight — this agent is idle. Use queueForNextRun() to leave a message for the next one.',
			details: {},
			retryable: false,
		})
		this.name = 'AgentNotRunningError'
	}
}

export interface AgentHandle {
	readonly status: AgentHandleStatus
	/**
	 * Hand guidance to the run happening now.
	 *
	 * Reaches the model at the next turn boundary whether or not a tool is
	 * in flight — the channel rides a settled tool result when there is one,
	 * and the loop delivers the remainder otherwise.
	 */
	steer(text: string): void
	/** Leave a message for the run that has not started yet. */
	queueForNextRun(message: Message): Promise<void>
}

export interface AgentHandleOptions {
	readonly steering: SteeringChannel
	/** Where a queued message is persisted. Absent means it cannot be. */
	readonly topicStateStore?: TopicStateStore
	readonly topicId: TopicId
	readonly tenantId: TenantId
	/** Live, not captured — the status has to be true when it is asked. */
	readonly isRunning: () => boolean
}

/**
 * A host's handle on one agent.
 *
 * `status` is a function call rather than a stored boolean, because a
 * stored one is only as current as whoever remembered to update it — and
 * the whole value of this object is answering a question at the moment it
 * is asked.
 */
export function createAgentHandle(options: AgentHandleOptions): AgentHandle {
	return {
		get status(): AgentHandleStatus {
			return options.isRunning() ? 'running' : 'idle'
		},

		steer(text: string): void {
			// Refused, not rerouted. Quietly forwarding to `queueForNextRun`
			// would be a host asking to redirect what is happening now and
			// getting a message delivered minutes later to a different run —
			// which is worse than an error, because nothing says it happened.
			if (!options.isRunning()) throw new AgentNotRunningError()
			options.steering.steer(text)
		},

		async queueForNextRun(message: Message): Promise<void> {
			if (!options.topicStateStore) {
				throw new NamzuError({
					code: 'invalid_config',
					message:
						'queueForNextRun() needs a topic state store; this handle was built without one, so there is nowhere to leave the message.',
					details: { topicId: options.topicId },
					retryable: false,
				})
			}
			await appendQueuedMessage(options.topicStateStore, options.topicId, options.tenantId, message)
		},
	}
}

/**
 * Add a message to the topic's next-run queue, under compare-and-set.
 *
 * Read-modify-write against the record's revision, so two hosts queueing
 * for one conversation cannot silently drop each other's message — the
 * loser gets the store's stale-revision error and can retry with what it
 * now sees.
 */
export async function appendQueuedMessage(
	store: TopicStateStore,
	topicId: TopicId,
	tenantId: TenantId,
	message: Message,
): Promise<void> {
	const state = await store.getState(topicId, tenantId)
	await store.setQueuedMessages(topicId, tenantId, [...(state?.queuedMessages ?? []), message], {
		revision: state?.revision ?? 0,
	})
}

/**
 * Take whatever was queued for this topic, leaving the queue empty.
 *
 * Cleared as it is read, in the same compare-and-set write. A queue that
 * was read and cleared separately would re-deliver on a crash between the
 * two, and "start with this" arriving twice is a different instruction from
 * the one that was left.
 */
export async function drainQueuedMessages(
	store: TopicStateStore,
	topicId: TopicId,
	tenantId: TenantId,
): Promise<readonly Message[]> {
	const state = await store.getState(topicId, tenantId)
	const queued = state?.queuedMessages ?? []
	if (queued.length === 0) return []
	await store.setQueuedMessages(topicId, tenantId, [], { revision: state?.revision ?? 0 })
	return queued
}
