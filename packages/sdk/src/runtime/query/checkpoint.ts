import type { RunPersistence } from '../../manager/run/persistence.js'
import type { RunDiskStore } from '../../store/run/disk.js'
import type {
	ActiveNodeInfo,
	BranchStackEntry,
	CheckpointId,
	CheckpointSummary,
	IterationCheckpoint,
	PendingDecision,
} from '../../types/hitl/index.js'
import type { AssistantMessage } from '../../types/message/index.js'
import type { EmergencySaveData } from '../../types/run/emergency.js'
import type { CheckpointListEntry } from '../../types/run/replay.js'
import { ZERO_COST } from '../../utils/cost.js'
import { buildToolResultHashes } from '../../utils/hash.js'
import { generateCheckpointId } from '../../utils/id.js'
import { EmergencyProjectionUnresumableError } from './decision/errors.js'

function toCheckpointListEntry(cp: IterationCheckpoint): CheckpointListEntry {
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
 * **It REFUSES a dump taken while the run was awaiting a decision** — the third door
 * onto the ses_017 bug. An emergency dump carries no `pendingDecision` (it snapshots
 * the run, not the checkpoint), so projecting one would hand the resume path a history
 * with an unowned dangling tool call, which `repairDanglingMessages` would dutifully
 * rewrite into "tool result missing" — destroying the very decision the run was parked
 * on. The real review checkpoint is on disk with the whole decision intact, and the
 * dump names it, so refusing with a pointer to it is strictly more useful than
 * producing a corrupted fork. See {@link EmergencySaveData.awaitingDecision}.
 *
 * See ses_005-deterministic-replay design §2 + §5.2.
 */
export function projectEmergencyToCheckpoint(dump: EmergencySaveData): IterationCheckpoint {
	if (dump.awaitingDecision) {
		throw new EmergencyProjectionUnresumableError(
			dump.runId,
			dump.awaitingDecision.checkpointId,
			dump.awaitingDecision.requestId,
		)
	}
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

export class CheckpointManager {
	private store: RunDiskStore

	constructor(store: RunDiskStore) {
		this.store = store
	}

	/**
	 * Snapshot the run at `iteration`.
	 *
	 * `activeElapsedMs` is the execution time the run has consumed across ALL
	 * of its segments — read it from
	 * {@link import('./guard.js').GuardCoordinator.activeElapsedMs}, which is
	 * the only thing that meters it. It cannot be derived here from
	 * `runMgr.startedAt`: on a resumed run that field is the *segment's* start,
	 * so a checkpoint written after a resume would claim the run had only ever
	 * run for the length of the current segment, and the next resume would hand
	 * back the time the previous ones spent. A required parameter rather than a
	 * defaulted one precisely so that a caller cannot forget to answer.
	 */
	async create(
		runMgr: RunPersistence,
		iteration: number,
		activeElapsedMs: number,
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
				elapsedMs: Math.max(0, activeElapsedMs),
			},
			createdAt: Date.now(),
			toolResultHashes: extra?.toolResults ? buildToolResultHashes(extra.toolResults) : undefined,
			branchStack: extra?.branchStack,
			activeNode: extra?.activeNode,
		}

		await this.store.writeCheckpoint(checkpoint)
		return checkpoint
	}

	/**
	 * Move a checkpoint's {@link PendingDecision} through its state machine.
	 *
	 * Every transition — `pending → resolved → executing → settled`, and `cancelled` —
	 * goes through here, under the store's per-checkpoint lock, so a state change and
	 * the journal it carries are written in one atomic file replacement. A caller that
	 * hand-rolled a read-mutate-write would race a concurrent redemption and lose the
	 * journal that says which tools already ran.
	 *
	 * Returns the decision as persisted, or `null` if the checkpoint has none.
	 */
	async updatePendingDecision(
		checkpointId: CheckpointId,
		mutate: (decision: PendingDecision) => PendingDecision,
	): Promise<PendingDecision | null> {
		const updated = await this.store.updateCheckpoint(checkpointId, (checkpoint) => {
			if (!checkpoint.pendingDecision) return undefined
			return {
				...checkpoint,
				pendingDecision: { ...mutate(checkpoint.pendingDecision), updatedAt: Date.now() },
			}
		})
		return updated?.pendingDecision ?? null
	}

	/** Attach a freshly-minted pending decision to a checkpoint that was just written. */
	async attachPendingDecision(
		checkpointId: CheckpointId,
		decision: PendingDecision,
	): Promise<void> {
		await this.store.updateCheckpoint(checkpointId, (checkpoint) => ({
			...checkpoint,
			pendingDecision: decision,
		}))
	}

	async restore(checkpointId: CheckpointId): Promise<IterationCheckpoint> {
		const checkpoint = await this.store.readCheckpoint(checkpointId)
		if (!checkpoint) {
			throw new Error(`Checkpoint not found: ${checkpointId}`)
		}
		return checkpoint
	}

	async list(): Promise<IterationCheckpoint[]> {
		return this.store.listCheckpoints()
	}

	/**
	 * Listing projection used by the public `listCheckpoints` API. Returns
	 * only the fields a consumer needs to pick a fork point for
	 * {@link import('./replay/prepare.js').prepareReplayState} — not the
	 * full checkpoint payload. See ses_005-deterministic-replay design §3.1.
	 */
	async listEntries(): Promise<CheckpointListEntry[]> {
		const checkpoints = await this.store.listCheckpoints()
		return checkpoints.map(toCheckpointListEntry)
	}

	async prune(keepLast: number): Promise<void> {
		const all = await this.list()
		if (all.length <= keepLast) return

		const toDelete = all.sort((a, b) => a.createdAt - b.createdAt).slice(0, all.length - keepLast)

		for (const cp of toDelete) {
			await this.store.deleteCheckpoint(cp.id)
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
