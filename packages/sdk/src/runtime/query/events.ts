import { NAMZU } from '../../constants/telemetry/index.js'
import type { PlanEvent, PlanManager } from '../../manager/plan/lifecycle.js'
import type { TurnBeginDraft, TurnRecorder } from '../../manager/session/turn-recorder.js'
import { buildProbeContext } from '../../probe/context.js'
import { probe as defaultProbeRegistry } from '../../probe/registry.js'
import type { ProbeObservation } from '../../probe/registry.js'
import type { ActivityEvent, ActivityStore } from '../../store/activity/memory.js'
import { createAnchoredSessionTextEvidenceSource } from '../../store/evidence/disk.js'
import type { SessionTextEvidenceSource } from '../../store/evidence/types.js'
import type { ReadSessionLogOptions, SessionLogEntry } from '../../store/session-log/index.js'
import type { CheckpointId, SessionId, TurnId } from '../../types/ids/index.js'
import { type SessionEvent, isEphemeralEvent } from '../../types/session/events.js'
import type { SessionRecord } from '../../types/session/records.js'
import type { TaskEvent, TaskStore } from '../../types/task/index.js'
import { awaitWithAbort } from '../../utils/await-with-abort.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'

/**
 * A live event as the loop builds it: `sessionId` and `turnId` may be left
 * out, and the translator stamps the turn's own.
 */
export type SessionEventDraft = SessionEvent extends infer E
	? E extends SessionEvent
		? Omit<E, 'sessionId' | 'turnId'> & { sessionId?: SessionId; turnId?: TurnId }
		: never
	: never

export type EmitEvent = (event: SessionEventDraft) => Promise<void>

/**
 * Soft cap on the in-memory pending-event queue. When the queue exceeds
 * this size and a new ephemeral event arrives, the oldest ephemeral
 * event is dropped to make room. Lifecycle events are never dropped —
 * they carry state transitions consumers cannot reconstruct.
 *
 * Sized for ~5–10 seconds of worst-case provider delta cadence
 * (100 deltas/s sustained) before pressure kicks in.
 */
const PENDING_EVENT_SOFT_CAP = 1000

/**
 * The turn's one funnel from "something happened" to the live stream and the
 * session log.
 *
 * Every non-ephemeral event is appended to the session log first (through
 * the turn's {@link TurnRecorder}, in order with its messages and records),
 * and only then queued for the consumer carrying the record's `seq` and
 * `generation`. A failed append still delivers the event, unstamped: losing
 * the news of a failure is worse than delivering it without a cursor.
 */
export class EventTranslator {
	private pendingEvents: SessionEvent[] = []
	private readonly recorder: TurnRecorder
	private probes: ProbeObservation
	private droppedDeltaCount = 0
	private readonly log: Logger

	constructor(
		recorder: TurnRecorder,
		probeRegistry: ProbeObservation = defaultProbeRegistry,
		log?: Logger,
	) {
		this.recorder = recorder
		this.probes = probeRegistry
		this.log = resolveLogger(log).child({ [SCOPE_ATTRIBUTE]: 'runtime/query/events' })
	}

	/** Serializes appends and reads against each other. */
	private appendChain: Promise<void> = Promise.resolve()

	private async withLogLock<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.appendChain
		let release!: () => void
		this.appendChain = new Promise<void>((resolve) => {
			release = resolve
		})
		try {
			await previous
			return await operation()
		} finally {
			release()
		}
	}

	/** The session log's records, read between whole appends. */
	readRecords(options: ReadSessionLogOptions = {}): Promise<readonly SessionRecord[]> {
		return this.withLogLock(async () => {
			await this.recorder.flush()
			const read = await this.recorder.log.readAll(options)
			return read.entries.map((entry) => entry.record)
		})
	}

	/**
	 * A text evidence source over the turn's session log, captured while the
	 * turn is running. `undefined` for a log that is not on disk.
	 */
	captureSessionEvidence(
		maxReadBytes?: number,
		signal?: AbortSignal,
	): Promise<SessionTextEvidenceSource | undefined> {
		const capture = this.withLogLock(async () => {
			signal?.throwIfAborted()
			if (this.recorder.status !== 'running') {
				throw new Error('Evidence capture requires the active invocation.')
			}
			const head = await this.recorder.head()
			const logPath = (this.recorder.log as { file?: unknown }).file
			if (typeof logPath !== 'string' || !head) return undefined
			// Anchored at the head this writer just appended: records appended
			// later neither invalidate the capture nor become visible to it.
			const source = createAnchoredSessionTextEvidenceSource(
				{
					scope: {
						tenantId: this.recorder.tenantId,
						projectId: this.recorder.projectId,
						sessionId: this.recorder.sessionId,
						turnId: this.recorder.turnId,
					},
					logPath,
					consistency: 'snapshot',
					...(maxReadBytes !== undefined ? { maxReadBytes } : {}),
				},
				head.pointer,
			)
			signal?.throwIfAborted()
			if (this.recorder.status !== 'running') {
				throw new Error('Evidence capture requires the active invocation.')
			}
			return source
		})
		return awaitWithAbort(capture, signal)
	}

	/** Stamp the turn's identity on an event the loop built without it. */
	private stamp(draft: SessionEventDraft): SessionEvent {
		return {
			...draft,
			sessionId: draft.sessionId ?? this.recorder.sessionId,
			...(draft.turnId !== undefined
				? { turnId: draft.turnId }
				: this.recorder.isClosed
					? {}
					: { turnId: this.recorder.turnId }),
		} as SessionEvent
	}

	readonly emitEvent: EmitEvent = async (draft: SessionEventDraft): Promise<void> => {
		const event = this.stamp(draft)
		this.probes.dispatch(
			event,
			buildProbeContext({ sessionId: event.sessionId, turnId: this.recorder.turnId }),
		)

		// Bound the queue: drop the oldest ephemeral event under pressure rather
		// than letting a slow consumer grow it without limit. Lifecycle events
		// are never dropped.
		if (this.pendingEvents.length >= PENDING_EVENT_SOFT_CAP) {
			const dropIdx = this.pendingEvents.findIndex(isEphemeralEvent)
			if (dropIdx !== -1) {
				this.pendingEvents.splice(dropIdx, 1)
				this.droppedDeltaCount += 1
				if (this.droppedDeltaCount === 1 || this.droppedDeltaCount % 100 === 0) {
					this.log.warn('Dropped ephemeral SessionEvent under bus pressure', {
						[NAMZU.TURN_ID]: this.recorder.turnId,
						'namzu.runtime.dropped_count': this.droppedDeltaCount,
						'namzu.runtime.queue_size': this.pendingEvents.length,
					})
				}
			}
		}

		// Ephemeral events never reach the log. No number, and that is the
		// honest statement: nothing persists this, so a consumer must never
		// advance a cursor to it.
		if (isEphemeralEvent(event)) {
			this.pendingEvents.push(event)
			return
		}

		// One appender at a time: task store, plan manager and parallel tools
		// all emit into this funnel, and the record's seq is taken against the
		// append, not before it.
		await this.withLogLock(async () => {
			let entry: Awaited<ReturnType<TurnRecorder['appendEvent']>>
			try {
				entry = await this.recorder.appendEvent(event)
			} catch (err) {
				this.pendingEvents.push(event)
				throw err
			}
			this.pendingEvents.push(
				entry === undefined
					? event
					: ({ ...event, seq: entry.record.seq, generation: entry.record.gen } as SessionEvent),
			)
		})
	}

	/**
	 * Begin the turn: `turn_started` in the log (with the prompt message it
	 * names right after it), and the same event on the live stream.
	 */
	async beginTurn(draft: TurnBeginDraft): Promise<void> {
		await this.withLogLock(async () => {
			const entry = await this.recorder.begin(draft)
			this.pendingEvents.push(liveEventOf(entry))
		})
	}

	/** Continue a paused or interrupted turn: `turn_resuming`, same `turnId`. */
	async resumeTurn(fromCheckpointId: CheckpointId, resolvedDecisionId?: string): Promise<void> {
		await this.withLogLock(async () => {
			const entry = await this.recorder.resume(fromCheckpointId, resolvedDecisionId)
			this.pendingEvents.push(liveEventOf(entry))
		})
	}

	*drainPending(): Generator<SessionEvent> {
		let event = this.pendingEvents.shift()
		while (event !== undefined) {
			yield event
			event = this.pendingEvents.shift()
		}
	}

	wireActivityStore(activityStore: ActivityStore): void {
		activityStore.on(async (event: ActivityEvent) => {
			const activity = event.activity
			if (event.type === 'activity.created') {
				await this.emitEvent({
					type: 'activity_created',
					activityId: activity.id,
					activityType: activity.type,
					description: activity.description,
				})
			} else {
				await this.emitEvent({
					type: 'activity_updated',
					activityId: activity.id,
					status: activity.status,
					output: activity.output,
					error: activity.error,
				})
			}
		})
	}

	/**
	 * Report the session's task list on the turn's stream. A task belongs to
	 * the session; every change to one of its tasks during this turn is
	 * reported, whichever turn created it.
	 */
	wireTaskStore(taskStore: TaskStore, sessionId: SessionId): () => void {
		const unsubscribe = taskStore.on(async (event: TaskEvent) => {
			const task = event.task

			if (task.sessionId !== sessionId) return
			switch (event.type) {
				case 'task.created':
					await this.emitEvent({
						type: 'task_created',
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
						taskId: task.id,
						subject: task.subject,
						status: task.status,
						owner: task.owner,
						...(task.blockedBy.length > 0 ? { blockedBy: task.blockedBy } : {}),
					})
					break
				default: {
					const _exhaustive: never = event.type
					throw new Error(`Unhandled task event type: ${_exhaustive}`)
				}
			}
		})
		return unsubscribe
	}

	wirePlanManager(planManager: PlanManager): void {
		planManager.on(async (event: PlanEvent) => {
			const plan = event.plan
			switch (event.type) {
				case 'plan.ready':
					await this.emitEvent({
						type: 'plan_ready',
						planId: plan.id,
						title: plan.title,
						steps: plan.steps,
						summary: plan.summary,
					})
					break
				case 'plan.approved':
					await this.emitEvent({ type: 'plan_approved', planId: plan.id })
					break
				case 'plan.rejected':
					await this.emitEvent({
						type: 'plan_rejected',
						planId: plan.id,
						reason: plan.rejectionReason,
					})
					break
				case 'plan.step_updated':
					if (event.step) {
						await this.emitEvent({
							type: 'plan_step_updated',
							planId: plan.id,
							stepId: event.step.id,
							status: event.step.status,
						})
					}
					break
				case 'plan.completed':
					await this.emitEvent({ type: 'plan_completed', planId: plan.id })
					break
				case 'plan.failed':
					await this.emitEvent({
						type: 'plan_failed',
						planId: plan.id,
						...(plan.failureReason ? { reason: plan.failureReason } : {}),
					})
					break
				// Silent: `plan.generating` and `plan.executing` are already
				// bracketed by `plan_ready` and `plan_approved`.
				case 'plan.generating':
				case 'plan.executing':
					break
				default: {
					const _exhaustive: never = event.type
					throw new Error(`Unhandled plan event type: ${_exhaustive}`)
				}
			}
		})
	}
}

/** The live event a lifecycle record stands for: its payload plus the envelope's identity and seq. */
function liveEventOf(entry: SessionLogEntry): SessionEvent {
	const {
		v: _v,
		id: _id,
		ts: _ts,
		prev: _prev,
		prevText: _prevText,
		gen,
		seq,
		...payload
	} = entry.record as SessionRecord & { prevText?: unknown }
	return { ...payload, seq, generation: gen } as unknown as SessionEvent
}
