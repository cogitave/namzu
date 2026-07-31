import type { RunPersistence } from '../../manager/run/persistence.js'
import type {
	ActiveNodeInfo,
	BranchStackEntry,
	CheckpointId,
	CheckpointSummary,
	HITLDecisionRequest,
	HITLResumeDecision,
	IterationCheckpoint,
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
 * The projection is lossy: `costInfo`, `guardState.elapsedMs`,
 * `toolResultHashes`, `branchStack`, and `activeNode` are not captured at
 * emergency-save time and default to zero/empty values. The synthetic
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
): Promise<IterationCheckpoint | null> {
	const all = await store.listCheckpoints(scope)
	// `listCheckpoints` is contractually ascending by `createdAt`; the
	// newest outstanding park is the one a human should be answering.
	for (let i = all.length - 1; i >= 0; i--) {
		const cp = all[i] as IterationCheckpoint
		if (cp.pending && cp.pending.resolvedAt === undefined) return cp
	}
	return null
}

export class CheckpointManager {
	private store: CheckpointStore
	private scope: CheckpointRunScope

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

	async create(
		runMgr: RunPersistence,
		iteration: number,
		extra?: {
			toolResults?: Array<{ toolCallId: string; toolName: string; input: unknown; output: string }>
			branchStack?: BranchStackEntry[]
			activeNode?: ActiveNodeInfo
		},
	): Promise<IterationCheckpoint> {
		const checkpoint: IterationCheckpoint = {
			id: generateCheckpointId(),
			runId: runMgr.id,
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
			branchStack: extra?.branchStack,
			activeNode: extra?.activeNode,
		}

		await this.store.writeCheckpoint(this.scope, checkpoint)
		return checkpoint
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
	): Promise<IterationCheckpoint> {
		const parked: IterationCheckpoint = {
			...checkpoint,
			pending: { request, parkedAt: Date.now() },
		}
		await this.store.writeCheckpoint(this.scope, parked)
		return parked
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
			throw new Error(`Checkpoint not found: ${checkpointId}`)
		}
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
