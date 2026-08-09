import type { CheckpointId, IterationCheckpoint } from '../../types/hitl/index.js'
import type {
	CheckpointListingScope,
	CheckpointRunScope,
	CheckpointStore,
	DurableRunEntry,
	DurableRunPage,
	ListDurableRunsOptions,
} from '../../types/run/checkpoint-store.js'
import { assertContiguousListingScope, paginateDurableRuns, toDurableRunEntry } from './listing.js'

/**
 * Process-local {@link CheckpointStore}, keyed by the full five-layer scope.
 *
 * Shipped rather than left as a test fixture for two reasons. It is the
 * reference a host reads when writing a backend of its own — the disk store
 * is path-addressed and answers "what does an attribution-keyed store look
 * like" with a directory layout, which is the wrong lesson. And it is the
 * only implementation that can hold more than one tenant at once, because
 * the disk layout has no tenant in it: a test that two tenants' listings
 * stay separate is not expressible against disk, and a rule that cannot be
 * tested on the store a host will actually inject is a rule on paper.
 *
 * Not durable, deliberately: it is for tests, for a single-process host that
 * genuinely wants checkpoints to die with the process, and as the parity
 * partner that proves the listing contract is not a filesystem in disguise.
 */
export class InMemoryCheckpointStore implements CheckpointStore {
	/** `tenant/project/session/run` → checkpoint id → checkpoint. */
	private readonly runs = new Map<string, Map<CheckpointId, IterationCheckpoint>>()
	/** Same key → the run's scope, so a listing can rebuild an addressable entry. */
	private readonly scopes = new Map<string, CheckpointRunScope>()

	private key(scope: CheckpointRunScope): string {
		return [scope.tenantId, scope.projectId, scope.sessionId, scope.runId].join('/')
	}

	async writeCheckpoint(scope: CheckpointRunScope, checkpoint: IterationCheckpoint): Promise<void> {
		const key = this.key(scope)
		let run = this.runs.get(key)
		if (!run) {
			run = new Map()
			this.runs.set(key, run)
		}
		// The run's scope is kept beside its checkpoints because the key is a
		// joined string and a listing has to hand back the parts — above all
		// `parentRunId`, which is what makes a sub-run's row addressable.
		//
		// Written on every call rather than only the first, and that is
		// simplicity, not defence: a run's scope is fixed when the run is
		// constructed, so the two cannot differ, and a `has` guard here would
		// be a branch no input can take.
		this.scopes.set(key, {
			tenantId: scope.tenantId,
			projectId: scope.projectId,
			sessionId: scope.sessionId,
			runId: scope.runId,
			...(scope.parentRunId ? { parentRunId: scope.parentRunId } : {}),
		})
		run.set(checkpoint.id, checkpoint)
	}

	async readCheckpoint(
		scope: CheckpointRunScope,
		checkpointId: CheckpointId,
	): Promise<IterationCheckpoint | null> {
		return this.runs.get(this.key(scope))?.get(checkpointId) ?? null
	}

	async listCheckpoints(scope: CheckpointRunScope): Promise<IterationCheckpoint[]> {
		const run = this.runs.get(this.key(scope))
		if (!run) return []
		return [...run.values()].sort((a, b) => a.createdAt - b.createdAt)
	}

	async deleteCheckpoint(scope: CheckpointRunScope, checkpointId: CheckpointId): Promise<void> {
		this.runs.get(this.key(scope))?.delete(checkpointId)
	}

	async listDurableRuns(
		scope: CheckpointListingScope,
		options?: ListDurableRunsOptions,
	): Promise<DurableRunPage> {
		assertContiguousListingScope(scope, 'InMemoryCheckpointStore.listDurableRuns')
		const now = options?.now ?? Date.now()

		const entries: DurableRunEntry[] = []
		for (const [key, checkpoints] of this.runs) {
			const runScope = this.scopes.get(key)
			if (!runScope) continue
			if (runScope.tenantId !== scope.tenantId) continue
			if (scope.projectId !== undefined && runScope.projectId !== scope.projectId) continue
			if (scope.sessionId !== undefined && runScope.sessionId !== scope.sessionId) continue

			const entry = toDurableRunEntry(runScope, [...checkpoints.values()], now)
			if (entry) entries.push(entry)
		}

		return paginateDurableRuns(entries, options)
	}
}
