import type { CheckpointId, IterationCheckpoint } from '../../types/hitl/index.js'
import type {
	CheckpointListingScope,
	CheckpointRunScope,
	CheckpointStore,
	ClaimFence,
	ClaimRunOptions,
	DurableRunEntry,
	DurableRunPage,
	ListDurableRunsOptions,
	RunClaim,
} from '../../types/run/checkpoint-store.js'
import {
	assertContiguousListingScope,
	fencedOut,
	paginateDurableRuns,
	toClaimSummary,
	toDurableRunEntry,
} from './listing.js'

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

	/** `tenant/project/session/run` → the run's current holding, if any. */
	private readonly claims = new Map<string, RunClaim>()

	/**
	 * The highest fence ever issued per run, kept separately from the claim.
	 *
	 * The claim is removed on release; this is not. That separation is the
	 * whole point: the first version deleted the claim and then computed the
	 * next fence from it, so releasing rewound the counter to 1 and a worker
	 * stalled at fence 1 could write beside a new holder also at fence 1 —
	 * and the documented `finally { releaseRun() }` did it on every pass.
	 *
	 * The disk store gets this property from file names that persist. In
	 * memory the equivalent is a high-water mark nothing clears, and the two
	 * must agree, because this class is what a host reads when writing a
	 * backend of its own.
	 */
	private readonly highWater = new Map<string, ClaimFence>()

	async claimRun(scope: CheckpointRunScope, options: ClaimRunOptions): Promise<RunClaim | null> {
		const key = this.key(scope)
		const now = options.now ?? Date.now()
		const held = this.claims.get(key)

		// Held by somebody else and still live. Not an error: two readers on
		// one queue is the ordinary case.
		if (held && now < held.expiresAt && held.holder !== options.holder) return null

		// A reclaim of an expired holding and a renewal by the current holder
		// are the same write. The fence advances either way, so a previous
		// holder that wakes up is fenced out in both cases — a renewal that
		// kept the fence would leave a stalled twin able to write.
		// Counted from the high-water mark, never from the live claim. A
		// released run has no claim, and computing from that absence is what
		// rewound the counter to 1 on every release.
		const fence = (this.highWater.get(key) ?? 0) + 1
		const claim: RunClaim = { holder: options.holder, fence, expiresAt: now + options.ttlMs }
		this.highWater.set(key, fence)
		this.claims.set(key, claim)
		return claim
	}

	async releaseRun(scope: CheckpointRunScope, fence: ClaimFence): Promise<void> {
		const key = this.key(scope)
		const held = this.claims.get(key)
		// A stale fence releases nothing. A worker that stalled past its lease
		// must not be able to hand away a run somebody else now holds.
		//
		// The high-water mark deliberately survives this. Dropping the claim
		// returns the run to the queue; forgetting the number it reached would
		// re-issue a fence a stalled worker still believes it holds.
		if (held && held.fence === fence) this.claims.delete(key)
	}

	async writeCheckpoint(
		scope: CheckpointRunScope,
		checkpoint: IterationCheckpoint,
		fence?: ClaimFence,
	): Promise<void> {
		const key = this.key(scope)
		// An unfenced write is allowed even on a claimed run: a host adopting
		// claims on one worker must not break the workers that have not
		// adopted them. A fenced write is checked, and that check is what
		// makes the lease real.
		if (fence !== undefined) {
			const held = this.claims.get(key)
			if (held && fence < held.fence) throw fencedOut(scope, fence, held.fence)
		}
		return this.writeUnchecked(scope, checkpoint)
	}

	private async writeUnchecked(
		scope: CheckpointRunScope,
		checkpoint: IterationCheckpoint,
	): Promise<void> {
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
			if (!entry) continue
			const claim = this.claims.get(key)
			entries.push(claim ? { ...entry, claim: toClaimSummary(claim, now) } : entry)
		}

		return paginateDurableRuns(entries, options)
	}
}
