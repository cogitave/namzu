import type { PlanEvent, PlanManager } from '../../manager/plan/lifecycle.js'
import type { RunPersistence } from '../../manager/run/persistence.js'
import { buildProbeContext } from '../../probe/context.js'
import { type ProbeRegistry, probe as defaultProbeRegistry } from '../../probe/registry.js'
import type { ActivityEvent, ActivityStore } from '../../store/activity/memory.js'
import type { RunId } from '../../types/ids/index.js'
import { isEphemeralEvent } from '../../types/run/events.js'
import type { RunEvent } from '../../types/run/index.js'
import type { TaskEvent, TaskStore } from '../../types/task/index.js'
import { getRootLogger } from '../../utils/logger.js'

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
 * Codex D2 (ses_001-tool-stream-events).
 */
const PENDING_EVENT_SOFT_CAP = 1000

export class EventTranslator {
	private pendingEvents: RunEvent[] = []
	private runMgr: RunPersistence
	private probes: ProbeRegistry
	private droppedDeltaCount = 0
	private readonly log = getRootLogger().child({ component: 'EventTranslator' })

	constructor(runMgr: RunPersistence, probeRegistry: ProbeRegistry = defaultProbeRegistry) {
		this.runMgr = runMgr
		this.probes = probeRegistry
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

		this.pendingEvents.push(event)

		// D1 middle path: ephemeral events never enter `transcript.jsonl`.
		// They live only on the in-memory bus for live UI rendering.
		// Replay (`runtime/query/replay/prepare.ts`) reads checkpoints
		// not transcripts, so this preserves replay fidelity while
		// eliminating the durable bloat codex flagged.
		if (!isEphemeralEvent(event)) {
			await this.runMgr.getRunStore().appendEvent(event)
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
				case 'plan.generating':
				case 'plan.executing':
				case 'plan.completed':
				case 'plan.failed':
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
