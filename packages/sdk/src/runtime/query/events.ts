import type { PlanEvent, PlanManager } from '../../manager/plan/lifecycle.js'
import type { RunPersistence } from '../../manager/run/persistence.js'
import { buildProbeContext } from '../../probe/context.js'
import { type ProbeRegistry, probe as defaultProbeRegistry } from '../../probe/registry.js'
import type { ActivityEvent, ActivityStore } from '../../store/activity/memory.js'
import type { RunId } from '../../types/ids/index.js'
import type { ClaimFence } from '../../types/run/checkpoint-store.js'
import { isEphemeralEvent } from '../../types/run/events.js'
import type { RunEvent } from '../../types/run/index.js'
import type { TaskEvent, TaskStore } from '../../types/task/index.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'

export type EmitEvent = (event: RunEvent) => Promise<void>

/**
 * Soft cap on the in-memory pending-event queue. When the queue exceeds
 * this size and a new ephemeral event arrives, the oldest ephemeral
 * event is dropped to make room. Lifecycle events are never dropped —
 * they carry state transitions consumers cannot reconstruct.
 *
 * Sized for ~5–10 seconds of worst-case provider delta cadence
 * (100 deltas/s sustained) before pressure kicks in. Tune via
 * empirical evidence; not a hard guarantee, just a safety net.
 *
 * See ses_001-tool-stream-events.
 */
const PENDING_EVENT_SOFT_CAP = 1000

export class EventTranslator {
	private pendingEvents: RunEvent[] = []
	private runMgr: RunPersistence
	private probes: ProbeRegistry
	private droppedDeltaCount = 0
	private readonly log: Logger

	constructor(
		runMgr: RunPersistence,
		probeRegistry: ProbeRegistry = defaultProbeRegistry,
		log?: Logger,
	) {
		this.runMgr = runMgr
		this.probes = probeRegistry
		this.log = resolveLogger(log).child({ component: 'EventTranslator' })
	}

	/**
	 * The claim this run is being written under, when it holds one.
	 *
	 * Stamped on every durable event as its `generation`, so a consumer whose
	 * cursor predates a takeover is told its sequence space changed instead of
	 * being handed a splice from a different writer's log.
	 */
	private generation: ClaimFence | undefined

	/** Serializes sequence assignment against the append. See {@link emitEvent}. */
	private appendChain: Promise<void> = Promise.resolve()

	setGeneration(fence: ClaimFence | undefined): void {
		this.generation = fence
	}

	readonly emitEvent: EmitEvent = async (event: RunEvent): Promise<void> => {
		this.probes.dispatch(event, buildProbeContext({ runId: event.runId }))

		// D2: bound the queue. Drop oldest ephemeral events under
		// pressure rather than letting unbounded growth swamp a slow
		// consumer (or lock the orchestrator on awaitable disk I/O).
		// Lifecycle events are sacred — they carry state transitions a
		// consumer cannot reconstruct from neighbouring events.
		if (this.pendingEvents.length >= PENDING_EVENT_SOFT_CAP) {
			const dropIdx = this.pendingEvents.findIndex(isEphemeralEvent)
			if (dropIdx !== -1) {
				this.pendingEvents.splice(dropIdx, 1)
				this.droppedDeltaCount += 1
				if (this.droppedDeltaCount === 1 || this.droppedDeltaCount % 100 === 0) {
					this.log.warn('Dropped ephemeral RunEvent under bus pressure', {
						runId: event.runId,
						droppedCount: this.droppedDeltaCount,
						queueSize: this.pendingEvents.length,
					})
				}
			}
			// If no ephemeral events are buffered the lifecycle events
			// themselves are the queue's contents — accept the overflow
			// and rely on consumer drain catching up. Better to grow
			// briefly than to drop a state transition.
		}

		// D1 middle path: ephemeral events never enter `transcript.jsonl`.
		// They live only on the in-memory bus for live UI rendering.
		// Replay (`runtime/query/replay/prepare.ts`) reads checkpoints
		// not transcripts, so this preserves replay fidelity while
		// eliminating the durable bloat review flagged.
		if (isEphemeralEvent(event)) {
			// No number, and that is the honest statement: nothing will
			// persist this, so a consumer must never advance a cursor to it.
			this.pendingEvents.push(event)
			return
		}

		// One appender at a time, and this is not a precaution — it is the fix
		// for a measured defect. Taking the number, awaiting the write and then
		// committing is a read-modify-write, and emits genuinely interleave:
		// the task store, the plan manager and a batch of parallel tools all
		// emit into this one funnel. Measured on a two-tool run, three events
		// took the number 15 and two took 12. A duplicated sequence is worse
		// than a missing one — a consumer asking for everything above 15 is
		// handed part of the run it already had, spliced in as if it were new.
		const previous = this.appendChain
		let release!: () => void
		this.appendChain = new Promise<void>((resolve) => {
			release = resolve
		})

		try {
			await previous

			// The number is a claim that the event is IN the log, so it is taken
			// against the append and not before it. The candidate goes to the
			// store first; only a write that landed advances the counter and
			// reaches the live stream carrying it.
			//
			// The failure path still delivers the event — unstamped. A store
			// that cannot record a `run_failed` must not also swallow it, and an
			// unstamped event says exactly what is true of it: it happened, and
			// it is not recoverable.
			const seq = this.runMgr.nextEventSeq()
			const stamped = {
				...event,
				seq,
				...(this.generation !== undefined ? { generation: this.generation } : {}),
			} as RunEvent

			try {
				await this.runMgr.getRunStore().appendEvent(stamped)
			} catch (err) {
				this.pendingEvents.push(event)
				throw err
			}

			this.runMgr.commitEventSeq(seq)
			this.pendingEvents.push(stamped)
		} finally {
			release()
		}
	};

	*drainPending(): Generator<RunEvent> {
		let event = this.pendingEvents.shift()
		while (event !== undefined) {
			yield event
			event = this.pendingEvents.shift()
		}
	}

	wireActivityStore(activityStore: ActivityStore, runId: RunId): void {
		activityStore.on(async (event: ActivityEvent) => {
			const activity = event.activity
			if (event.type === 'activity.created') {
				await this.emitEvent({
					type: 'activity_created',
					runId,
					activityId: activity.id,
					activityType: activity.type,
					description: activity.description,
				})
			} else {
				await this.emitEvent({
					type: 'activity_updated',
					runId,
					activityId: activity.id,
					status: activity.status,
					output: activity.output,
					error: activity.error,
				})
			}
		})
	}

	wireTaskStore(taskStore: TaskStore, runId: RunId): () => void {
		const unsubscribe = taskStore.on(async (event: TaskEvent) => {
			const task = event.task

			if (task.runId !== runId) return
			switch (event.type) {
				case 'task.created':
					await this.emitEvent({
						type: 'task_created',
						runId,
						taskId: task.id,
						subject: task.subject,
						status: task.status,
						// Absent rather than empty: a reader must be able to tell
						// "depends on nothing" from an emitter that predates these.
						...(task.blockedBy.length > 0 ? { blockedBy: task.blockedBy } : {}),
						...(task.owner !== undefined ? { owner: task.owner } : {}),
					})
					break
				case 'task.updated':
				case 'task.claimed':
				case 'task.deleted':
					await this.emitEvent({
						type: 'task_updated',
						runId,
						taskId: task.id,
						subject: task.subject,
						status: task.status,
						owner: task.owner,
						...(task.blockedBy.length > 0 ? { blockedBy: task.blockedBy } : {}),
					})
					break
				default: {
					// `TaskEvent.type` is scoped to task-store events; sub-session
					// lifecycle events (subsession_spawned / _messaged / _idled) and
					// run-scoped `RunEvent` variants never reach this wrapper. The
					// exhaustiveness guard below enforces that at compile time.
					const _exhaustive: never = event.type
					throw new Error(`Unhandled task event type: ${_exhaustive}`)
				}
			}
		})
		return unsubscribe
	}

	wirePlanManager(planManager: PlanManager, runId: RunId): void {
		planManager.on(async (event: PlanEvent) => {
			const plan = event.plan
			switch (event.type) {
				case 'plan.ready':
					await this.emitEvent({
						type: 'plan_ready',
						runId,
						planId: plan.id,
						title: plan.title,
						steps: plan.steps,
						summary: plan.summary,
					})
					break
				case 'plan.approved':
					await this.emitEvent({
						type: 'plan_approved',
						runId,
						planId: plan.id,
					})
					break
				case 'plan.rejected':
					await this.emitEvent({
						type: 'plan_rejected',
						runId,
						planId: plan.id,
						reason: plan.rejectionReason,
					})
					break
				case 'plan.step_updated':
					if (event.step) {
						await this.emitEvent({
							type: 'plan_step_updated',
							runId,
							planId: plan.id,
							stepId: event.step.id,
							status: event.step.status,
						})
					}
					break
				case 'plan.completed':
					await this.emitEvent({
						type: 'plan_completed',
						runId,
						planId: plan.id,
					})
					break
				case 'plan.failed':
					await this.emitEvent({
						type: 'plan_failed',
						runId,
						planId: plan.id,
						...(plan.failureReason ? { reason: plan.failureReason } : {}),
					})
					break
				// Deliberately silent, and not for the same reason the terminal
				// pair used to be. `plan.generating` and `plan.executing` are
				// already bracketed by `plan_ready` and `plan_approved` — a
				// consumer learns both facts from events it already gets, so an
				// event here would carry nothing a reader did not have.
				case 'plan.generating':
				case 'plan.executing':
					break
				default: {
					// `PlanEvent.type` is scoped to plan-manager events; sub-session
					// lifecycle events and other `RunEvent` variants never reach this
					// wrapper. The exhaustiveness guard below enforces that at compile
					// time.
					const _exhaustive: never = event.type
					throw new Error(`Unhandled plan event type: ${_exhaustive}`)
				}
			}
		})
	}
}
