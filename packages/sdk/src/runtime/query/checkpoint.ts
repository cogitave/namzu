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
import { buildToolResultHashes } from '../../utils/hash.js'
import { generateCheckpointId } from '../../utils/id.js'

export class CheckpointManager {
	private store: RunDiskStore

	constructor(store: RunDiskStore) {
		this.store = store
	}

	async create(
		sessionMgr: RunPersistence,
		iteration: number,
		extra?: {
			toolResults?: Array<{ toolCallId: string; toolName: string; input: unknown; output: string }>
			branchStack?: BranchStackEntry[]
			activeNode?: ActiveNodeInfo
		},
	): Promise<IterationCheckpoint> {
		const checkpoint: IterationCheckpoint = {
			id: generateCheckpointId(),
			runId: sessionMgr.id,
			iteration,
			messages: [...sessionMgr.messages],
			tokenUsage: { ...sessionMgr.tokenUsage },
			costInfo: { ...sessionMgr.costInfo },
			guardState: {
				iterationCount: sessionMgr.currentIteration,
				elapsedMs: Date.now() - (sessionMgr.getSession().startedAt ?? Date.now()),
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

	async prune(keepLast: number): Promise<void> {
		const all = await this.list()
		if (all.length <= keepLast) return

		const toDelete = all.sort((a, b) => a.createdAt - b.createdAt).slice(0, all.length - keepLast)

		for (const cp of toDelete) {
			await this.store.deleteCheckpoint(cp.id)
		}
	}

	static buildSummary(sessionMgr: RunPersistence, iteration: number): CheckpointSummary {
		const lastAssistant = [...sessionMgr.messages]
			.reverse()
			.find((m): m is AssistantMessage => m.role === 'assistant' && m.content !== null)

		return {
			iteration,
			messageCount: sessionMgr.messages.length,
			tokenUsage: { ...sessionMgr.tokenUsage },
			costInfo: { ...sessionMgr.costInfo },
			lastAssistantMessage: lastAssistant?.content ?? undefined,
		}
	}
}
