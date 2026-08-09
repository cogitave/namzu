import type { WorkingStateSnapshot } from '../../compaction/wire.js'
import type { RunPersistence } from '../../manager/run/persistence.js'
import type { SerializedSpanContext } from '../../telemetry/attributes.js'
import { NamzuError } from '../../types/errors/index.js'
import type {
	CheckpointId,
	CheckpointSummary,
	HITLDecisionRequest,
	HITLResumeDecision,
	IterationCheckpoint,
	PendingDecision,
} from '../../types/hitl/index.js'
import type { AssistantMessage } from '../../types/message/index.js'
import type { CheckpointRunScope, CheckpointStore } from '../../types/run/checkpoint-store.js'
import type { EmergencySaveData } from '../../types/run/emergency.js'
import type { CheckpointListEntry } from '../../types/run/replay.js'
import { ZERO_COST } from '../../utils/cost.js'
import { buildToolResultHashes } from '../../utils/hash.js'
import { generateCheckpointId } from '../../utils/id.js'

/**
 * Projection from a full checkpoint payload to the public listing entry.
 * Exported for the replay `listCheckpoints` entry point, which projects
 * store results without constructing a `CheckpointManager`.
 */
export function toCheckpointListEntry(cp: IterationCheckpoint): CheckpointListEntry {
	return {
		id: cp.id,
		runId: cp.runId,
		iteration: cp.iteration,
		createdAt: cp.createdAt,
		messageCount: cp.messages.length,
	}
}

/**
 * Project an {@link EmergencySaveData} dump to an {@link IterationCheckpoint}
 * shape so `replay({ fromCheckpoint: 'emergency' })` can consume it through
 * the same restore path as any other checkpoint.
 *
 * The projection is lossy: `costInfo`, `guardState.elapsedMs` and
 * `toolResultHashes` are not captured at emergency-save time and default
 * to zero/empty values. The synthetic
 * checkpoint id is derived deterministically from the emergency save id so
 * re-projecting the same dump yields the same {@link CheckpointId}.
 *
 * See ses_005-deterministic-replay design §2 + §5.2.
 */
export function projectEmergencyToCheckpoint(dump: EmergencySaveData): IterationCheckpoint {
	const emergencySuffix = dump.id.replace(/^esave_/, '')
	return {
		id: `cp_emergency_${emergencySuffix}` as CheckpointId,
		runId: dump.runId,
		// The dump records the run's start, so this projection carries the
		// same stamp an ordinary checkpoint of that run would — a run whose
		// only surviving record is an emergency dump still has a real
		// attribution instant, and dropping it here would put that run in the
		// "never recorded" bucket for no reason.
		runCreatedAt: dump.startedAt,
		iteration: dump.currentIteration,
		messages: dump.messages,
		tokenUsage: dump.tokenUsage,
		costInfo: { ...ZERO_COST },
		guardState: {
			iterationCount: dump.currentIteration,
			elapsedMs: Math.max(0, dump.savedAt - dump.startedAt),
		},
		createdAt: dump.savedAt,
	}
}

/**
 * The newest checkpoint of a run that is still awaiting a human decision,
 * or `null` when the run is not parked.
 *
 * Standalone (not a `CheckpointManager` method) so a host can ask the
 * question without constructing a run: an approval-queue worker in a
 * different process has a store and a scope, and nothing else.
 */
export async function findPendingCheckpoint(
	store: CheckpointStore,
	scope: CheckpointRunScope,
	options?: { readonly now?: number },
): Promise<IterationCheckpoint | null> {
	const all = await store.listCheckpoints(scope)
	const now = options?.now ?? Date.now()
	// `listCheckpoints` is contractually ascending by `createdAt`; the
	// newest outstanding park is the one a human should be answering.
	for (let i = all.length - 1; i >= 0; i--) {
		const cp = all[i] as IterationCheckpoint
		if (!cp.pending || cp.pending.resolvedAt !== undefined) continue
		// An expired park is not outstanding. Serving it re-presents an
		// approval whose window has closed, and every queue reader would
		// keep re-presenting it forever — a redeployed worker leaves a park
		// nobody will ever answer and nothing in-process can time out.
		if (isExpiredPark(cp.pending, now)) continue
		return cp
	}
	return null
}

/** Whether a park's absolute deadline has passed. No deadline never expires. */
export function isExpiredPark(pending: PendingDecision, now = Date.now()): boolean {
	return pending.deadlineAt !== undefined && now >= pending.deadlineAt
}

/**
 * Every outstanding park in a run, expired ones included, so a host can
 * sweep them.
 *
 * The out-of-process timer stays a host concern — consistent with the same
 * decision made for retention — but a host cannot sweep what it cannot
 * enumerate, and this is the read that makes a sweep a few lines rather
 * than a re-implementation of the store contract.
 */
export async function listExpiredParks(
	store: CheckpointStore,
	scope: CheckpointRunScope,
	options?: { readonly now?: number },
): Promise<IterationCheckpoint[]> {
	const all = await store.listCheckpoints(scope)
	const now = options?.now ?? Date.now()
	return all.filter(
		(cp) => cp.pending && cp.pending.resolvedAt === undefined && isExpiredPark(cp.pending, now),
	)
}

export class CheckpointManager {
	private store: CheckpointStore
	private scope: CheckpointRunScope
	/**
	 * Compaction's state source, when the run has one.
	 *
	 * Every checkpoint snapshots it, so a resumed run can carry forward the
	 * state its earlier summary was built from. Without that the next
	 * compaction supersedes that summary with one covering only post-resume
	 * activity, and the record of everything before the resume is gone.
	 */
	private workingStateSource?: () => WorkingStateSnapshot | undefined

	/**
	 * The most recent checkpoint this manager wrote, if any.
	 *
	 * A run that fails on a transient error needs to name the state a host
	 * should resume from. Re-listing the store to find it would be a disk
	 * read on the failure path, at the moment the run is least able to
	 * afford one; the id is already in hand.
	 */
	private lastCreatedId?: CheckpointId

	/** See {@link setTraceSource}. */
	private traceSource?: () => SerializedSpanContext | undefined

	/** See {@link setParkTtl}. */
	private parkTtlMs?: number

	/**
	 * The run's attribution instant, stamped onto every checkpoint this
	 * manager writes.
	 *
	 * Settled exactly once, by whichever of two things happens first, and
	 * never reassigned — every write to it below is `??=`, and there are only
	 * two:
	 *
	 *  - `restore` ADOPTS it from the checkpoint a resume came back through.
	 *    A resumed run is the same run, and its creation is already on the
	 *    record; a fresh process minting a new one would move the key that
	 *    exists specifically because it does not move.
	 *  - `create` MINTS it from the run's own start instant when nothing was
	 *    adopted, which is the fresh-run case.
	 *
	 * Restore runs during run setup, before the first iteration and therefore
	 * before the first `create`, so the adopt always wins on the resume path
	 * without either site needing to know which path it is on.
	 */
	private runCreatedAt?: number

	/**
	 * @param store scope-keyed checkpoint persistence. The default query
	 *   pipeline passes the run's disk-backed store
	 *   ({@link import('../../store/run/checkpoint-disk.js').DiskCheckpointStore});
	 *   hosts inject their own via `QueryParams.checkpointStore`.
	 * @param scope the run every operation of this manager is keyed to.
	 */
	constructor(store: CheckpointStore, scope: CheckpointRunScope) {
		this.store = store
		this.scope = scope
	}

	/** Wire compaction's state in, so every checkpoint carries a snapshot. */
	setWorkingStateSource(source: () => WorkingStateSnapshot | undefined): void {
		this.workingStateSource = source
	}

	/**
	 * The run's root span, so every checkpoint records the trace it was
	 * taken inside and a resume can join it rather than starting a second,
	 * unlinked one.
	 */
	setTraceSource(source: () => SerializedSpanContext | undefined): void {
		this.traceSource = source
	}

	async create(
		runMgr: RunPersistence,
		iteration: number,
		extra?: {
			toolResults?: Array<{ toolCallId: string; toolName: string; input: unknown; output: string }>
			workingState?: WorkingStateSnapshot
		},
	): Promise<IterationCheckpoint> {
		// The run's own start, not `Date.now()`. This is meant to say when the
		// run was attributed; taking the clock at the first checkpoint would
		// say when it first became durable, which is a different and later
		// fact, and naming it after the earlier one would make it wrong in
		// exactly the way that is hard to notice.
		this.runCreatedAt ??= runMgr.getSession().startedAt ?? Date.now()

		const checkpoint: IterationCheckpoint = {
			id: generateCheckpointId(),
			runId: runMgr.id,
			runCreatedAt: this.runCreatedAt,
			iteration,
			messages: [...runMgr.messages],
			tokenUsage: { ...runMgr.tokenUsage },
			costInfo: { ...runMgr.costInfo },
			guardState: {
				iterationCount: runMgr.currentIteration,
				elapsedMs: Date.now() - (runMgr.getSession().startedAt ?? Date.now()),
			},
			createdAt: Date.now(),
			toolResultHashes: extra?.toolResults ? buildToolResultHashes(extra.toolResults) : undefined,
			workingState: extra?.workingState ?? this.workingStateSource?.(),
			traceContext: this.traceSource?.(),
		}

		await this.store.writeCheckpoint(this.scope, checkpoint)
		this.lastCreatedId = checkpoint.id
		return checkpoint
	}

	/** See {@link lastCreatedId}. */
	get lastCheckpointId(): CheckpointId | undefined {
		return this.lastCreatedId
	}

	/**
	 * The trace a checkpoint was taken inside, for parenting a resumed run.
	 *
	 * Read separately and BEFORE the run's root span, because a span's
	 * parent can only be set at creation and the root is minted before the
	 * restore branch runs.
	 *
	 * Never throws. Telemetry continuity is worth a disk read; it is not
	 * worth failing a resume over, and the restore path immediately after
	 * will report a genuinely unreadable checkpoint far better than a
	 * tracing helper could.
	 */
	async readTraceContext(checkpointId: CheckpointId): Promise<SerializedSpanContext | undefined> {
		try {
			const checkpoint = await this.store.readCheckpoint(this.scope, checkpointId)
			return checkpoint?.traceContext
		} catch {
			return undefined
		}
	}

	/**
	 * Record that the run parked at `checkpoint` awaiting a human, and
	 * return the updated checkpoint.
	 *
	 * A park used to exist only as a suspended `await`: the checkpoint
	 * written just before it was indistinguishable from any mid-run
	 * checkpoint, so a host could not tell from durable state that a
	 * decision was outstanding — and a process boundary lost the request
	 * entirely. Writing the request down is what lets an approval queue be
	 * rebuilt, and what lets a resumed run apply the answer to the exact
	 * tool calls the human saw.
	 *
	 * Called after `create` rather than as an argument to it because the
	 * request carries the checkpoint's own id.
	 */
	async park(
		checkpoint: IterationCheckpoint,
		request: HITLDecisionRequest,
		options?: { readonly ttlMs?: number },
	): Promise<IterationCheckpoint> {
		const parkedAt = Date.now()
		const ttl = options?.ttlMs ?? this.parkTtlMs
		const parked: IterationCheckpoint = {
			...checkpoint,
			pending: {
				request,
				parkedAt,
				// Absolute, so it survives the process that set it. A
				// duration plus an in-process timer cannot: the worker gets
				// redeployed and the park becomes immortal.
				...(ttl !== undefined && ttl > 0 ? { deadlineAt: parkedAt + ttl } : {}),
			},
		}
		await this.store.writeCheckpoint(this.scope, parked)
		return parked
	}

	/** Default time-to-live applied to every park this manager records. */
	setParkTtl(ttlMs: number | undefined): void {
		this.parkTtlMs = ttlMs
	}

	/**
	 * Mark an expired park as no longer outstanding.
	 *
	 * Recorded rather than deleted: the checkpoint showing what was asked
	 * and that nobody answered in time is the evidence an approval gate is
	 * worth having, and the same reasoning already keeps a resolved
	 * decision on the record.
	 */
	async expire(checkpointId: CheckpointId): Promise<IterationCheckpoint | null> {
		const checkpoint = await this.store.readCheckpoint(this.scope, checkpointId)
		if (!checkpoint?.pending || checkpoint.pending.resolvedAt !== undefined) return null

		const expired: IterationCheckpoint = {
			...checkpoint,
			pending: {
				...checkpoint.pending,
				resolvedAt: Date.now(),
				// The park ended by running out of time, not by a decision.
				// An `abort` here would read as somebody having refused it.
				decision: { action: 'pause', reason: 'The approval request expired without an answer.' },
			},
		}
		await this.store.writeCheckpoint(this.scope, expired)
		return expired
	}

	/**
	 * Record the answer, so an outstanding park stops looking outstanding.
	 *
	 * The decision is kept rather than erased: a checkpoint that shows both
	 * what was asked and what was answered is the evidence trail an
	 * approval gate is worth having. A no-op when the checkpoint is gone
	 * (pruned) or was never parked.
	 */
	async unpark(
		checkpointId: CheckpointId,
		decision: HITLResumeDecision,
	): Promise<IterationCheckpoint | null> {
		const checkpoint = await this.store.readCheckpoint(this.scope, checkpointId)
		if (!checkpoint?.pending) return null

		const resolved: IterationCheckpoint = {
			...checkpoint,
			pending: { ...checkpoint.pending, resolvedAt: Date.now(), decision },
		}
		await this.store.writeCheckpoint(this.scope, resolved)
		return resolved
	}

	/**
	 * The run's outstanding park, if it has one — the newest checkpoint
	 * whose `pending` has no `resolvedAt`.
	 *
	 * This is the read a host's approval queue is built from, and it works
	 * across a process boundary because it consults the store rather than
	 * in-memory state.
	 */
	async findPending(): Promise<IterationCheckpoint | null> {
		return findPendingCheckpoint(this.store, this.scope)
	}

	async restore(checkpointId: CheckpointId): Promise<IterationCheckpoint> {
		const checkpoint = await this.store.readCheckpoint(this.scope, checkpointId)
		if (!checkpoint) {
			throw new NamzuError({
				code: 'not_found',
				message: `Checkpoint not found: ${checkpointId}`,
				details: { checkpointId, runId: this.scope.runId },
			})
		}

		// Adopt the run's recorded attribution. A resumed run is the SAME run
		// under the same id, and its creation is already on the record; a
		// fresh process minting a new one would step the stamp forward on
		// every resume, which is the motion it exists to avoid.
		//
		// This needs no "is it really my run" guard, and one was written and
		// removed: `readCheckpoint` is keyed by THIS manager's scope, so the
		// only checkpoints reachable here are the ones belonging to
		// `scope.runId`. A replay fork never arrives here at all — it reads
		// its origin through the SOURCE scope in `prepareReplayState` and
		// starts a fresh run, so it mints its own stamp rather than claiming
		// its origin's age. A guard that no input can trip would have read as
		// protection and been none.
		this.runCreatedAt ??= checkpoint.runCreatedAt

		return checkpoint
	}

	async list(): Promise<IterationCheckpoint[]> {
		return this.store.listCheckpoints(this.scope)
	}

	/**
	 * Listing projection used by the public `listCheckpoints` API. Returns
	 * only the fields a consumer needs to pick a fork point for
	 * {@link import('./replay/prepare.js').prepareReplayState} — not the
	 * full checkpoint payload. See ses_005-deterministic-replay design §3.1.
	 */
	async listEntries(): Promise<CheckpointListEntry[]> {
		const checkpoints = await this.store.listCheckpoints(this.scope)
		return checkpoints.map(toCheckpointListEntry)
	}

	async prune(keepLast: number): Promise<void> {
		const all = await this.list()
		if (all.length <= keepLast) return

		const toDelete = all.sort((a, b) => a.createdAt - b.createdAt).slice(0, all.length - keepLast)

		for (const cp of toDelete) {
			await this.store.deleteCheckpoint(this.scope, cp.id)
		}
	}

	static buildSummary(runMgr: RunPersistence, iteration: number): CheckpointSummary {
		const lastAssistant = [...runMgr.messages]
			.reverse()
			.find((m): m is AssistantMessage => m.role === 'assistant' && m.content !== null)

		return {
			iteration,
			messageCount: runMgr.messages.length,
			tokenUsage: { ...runMgr.tokenUsage },
			costInfo: { ...runMgr.costInfo },
			lastAssistantMessage: lastAssistant?.content ?? undefined,
		}
	}
}
