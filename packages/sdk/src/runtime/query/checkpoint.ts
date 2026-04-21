import type { RunPersistence } from '../../manager/run/persistence.js'
import type { RunDiskStore } from '../../store/run/disk.js'
import type {
	ActiveNodeInfo,
	BranchStackEntry,
	CheckpointId,
	CheckpointSummary,
	IterationCheckpoint,
} from '../../types/hitl/index.js'
import type { AssistantMessage } from '../../types/message/index.js'
import type { CheckpointListEntry } from '../../types/run/replay.js'
import { buildToolResultHashes } from '../../utils/hash.js'
import { generateCheckpointId } from '../../utils/id.js'

function toCheckpointListEntry(cp: IterationCheckpoint): CheckpointListEntry {
	return {
		id: cp.id,
		runId: cp.runId,
		iteration: cp.iteration,
		createdAt: cp.createdAt,
		messageCount: cp.messages.length,
	}
}

export class CheckpointManager {
	private store: RunDiskStore

	constructor(store: RunDiskStore) {
		this.store = store
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

		await this.store.writeCheckpoint(checkpoint)
		return checkpoint
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
	 * {@link import('./replay/index.js').replay} — not the full checkpoint
	 * payload. See ses_005-deterministic-replay design §3.1.
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
