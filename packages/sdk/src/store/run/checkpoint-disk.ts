import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { NamzuError } from '../../types/errors/index.js'
import type { CheckpointId, IterationCheckpoint } from '../../types/hitl/index.js'
import type { RunId, SessionId, TenantId } from '../../types/ids/index.js'
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
import type { RunStoreConfig } from '../../types/run/index.js'
import type { ProjectId } from '../../types/session/ids.js'
import { acquireClaim, readClaim, releaseClaim } from './claim-disk.js'
import { RunDiskStore, readCheckpointsIn } from './disk.js'
import {
	assertContiguousListingScope,
	fencedOut,
	paginateDurableRuns,
	toClaimSummary,
	toDurableRunEntry,
} from './listing.js'

/**
 * The attribution a disk store's own layout does not record.
 *
 * The canonical layout is
 * `{root}/projects/{projectId}/sessions/{sessionId}/runs/{runId}` — there is
 * no tenant segment anywhere in it, and `baseDir` is already one session's
 * `runs/` directory, so the project and session are implicit in a string the
 * store cannot parse back out without knowing the layout that built it.
 *
 * A per-run read never needed any of it: the caller supplies a full
 * `CheckpointRunScope` and the store only uses `runId`. A LISTING does — its
 * rows have to be addressable, and a row with no tenant is a row nothing can
 * be resumed from. So the store is told, once, what tree it is holding.
 */
export interface DiskCheckpointStoreAttribution {
	readonly tenantId: TenantId
	readonly projectId: ProjectId
	readonly sessionId: SessionId
}

/**
 * Disk conformance layer for {@link CheckpointStore}: adapts the existing
 * {@link RunDiskStore} checkpoint methods (which are bound to a single run
 * directory via `initRun`) to the scope-keyed store contract.
 *
 * Path-addressed: `baseDir` already encodes project/session (it is the
 * session's `runs/` directory), so only `scope.runId` / `scope.parentRunId`
 * participate in directory resolution — `tenantId`/`projectId`/`sessionId`
 * exist for backends that key by attribution instead of path.
 *
 * One `RunDiskStore` is bound (and its run directory created) per distinct
 * `runId`, then cached, so repeated checkpoint operations against the same
 * run don't re-run `initRun`.
 */
export class DiskCheckpointStore implements CheckpointStore {
	private readonly config: RunStoreConfig
	private readonly attribution?: DiskCheckpointStoreAttribution
	private readonly bound = new Map<RunId, Promise<RunDiskStore>>()

	/**
	 * @param config the run-store config; `baseDir` is one session's `runs/`
	 *   directory.
	 * @param attribution what tree this is, for
	 *   {@link DiskCheckpointStore.listDurableRuns}. Optional so that adding
	 *   the listing did not change an existing construction; a store built
	 *   without it refuses to list rather than inventing a tenant.
	 */
	constructor(config: RunStoreConfig, attribution?: DiskCheckpointStoreAttribution) {
		this.config = config
		this.attribution = attribution
	}

	private bind(scope: CheckpointRunScope): Promise<RunDiskStore> {
		const cached = this.bound.get(scope.runId)
		if (cached) return cached
		const promise = (async () => {
			const store = new RunDiskStore(this.config)
			await store.initRun(scope.runId, scope.parentRunId)
			return store
		})()
		this.bound.set(scope.runId, promise)
		// A failed bind must not poison the cache — the next call retries.
		promise.catch(() => {
			this.bound.delete(scope.runId)
		})
		return promise
	}

	async writeCheckpoint(
		scope: CheckpointRunScope,
		checkpoint: IterationCheckpoint,
		fence?: ClaimFence,
	): Promise<void> {
		const store = await this.bind(scope)
		if (fence !== undefined) {
			// Read at the moment of the write, not at the start of the run.
			// A holder that stalled past its lease believes it still holds,
			// and this is the only point at which it can be told otherwise.
			const held = await readClaim(this.runDir(scope))
			if (held && fence < held.fence) throw fencedOut(scope, fence, held.fence)
		}
		await store.writeCheckpoint(checkpoint)
	}

	async claimRun(scope: CheckpointRunScope, options: ClaimRunOptions): Promise<RunClaim | null> {
		return acquireClaim(this.runDir(scope), options)
	}

	async releaseRun(scope: CheckpointRunScope, fence: ClaimFence): Promise<void> {
		await releaseClaim(this.runDir(scope), fence)
	}

	/**
	 * The run's directory, resolved the same way `RunDiskStore.initRun` does.
	 *
	 * Duplicated rather than shared because the claim path must be derivable
	 * WITHOUT binding a store — binding creates the directory, and a claim
	 * read is a read. Kept beside the layout comment on `listDurableRuns` so
	 * the two stay together if the layout ever moves.
	 */
	private runDir(scope: CheckpointRunScope): string {
		return scope.parentRunId
			? join(this.config.baseDir, scope.parentRunId, 'children', scope.runId)
			: join(this.config.baseDir, scope.runId)
	}

	async readCheckpoint(
		scope: CheckpointRunScope,
		checkpointId: CheckpointId,
	): Promise<IterationCheckpoint | null> {
		const store = await this.bind(scope)
		return store.readCheckpoint(checkpointId)
	}

	async listCheckpoints(scope: CheckpointRunScope): Promise<IterationCheckpoint[]> {
		const store = await this.bind(scope)
		return store.listCheckpoints()
	}

	async deleteCheckpoint(scope: CheckpointRunScope, checkpointId: CheckpointId): Promise<void> {
		const store = await this.bind(scope)
		await store.deleteCheckpoint(checkpointId)
	}

	/**
	 * Every run with checkpoints under this store's tree.
	 *
	 * Reads the directories rather than binding a {@link RunDiskStore} per
	 * run, because binding CREATES the run directory — a listing that
	 * materialized a directory for every run it looked at would grow the tree
	 * it is reporting on.
	 *
	 * ### Why a two-level walk reaches every depth
	 *
	 * `initRun` nests exactly one level: a run with a parent goes to
	 * `{baseDir}/{parentRunId}/children/{runId}`, and a grandchild goes to
	 * `{baseDir}/{itsOwnParentRunId}/children/{runId}` — beside the top-level
	 * runs, not beneath its grandparent. So the tree is flat-with-one-nesting
	 * at every depth, `{baseDir}/*` plus `{baseDir}/* /children/*` enumerates
	 * all of it, and each run's `parentRunId` is the directory it sits under.
	 * A deep run leaves a bare shell directory under its own id at the top
	 * level (`{baseDir}/{parentRunId}` created by `mkdir -p` for a child of a
	 * run whose own data lives elsewhere); those hold no `checkpoints/` and
	 * drop out as entries with no durable state.
	 */
	async listDurableRuns(
		scope: CheckpointListingScope,
		options?: ListDurableRunsOptions,
	): Promise<DurableRunPage> {
		assertContiguousListingScope(scope, 'DiskCheckpointStore.listDurableRuns')

		const attribution = this.attribution
		if (!attribution) {
			throw new NamzuError({
				code: 'invalid_config',
				message:
					'DiskCheckpointStore.listDurableRuns: this store was constructed without attribution, so it cannot say which tenant, project or session its runs belong to — and a listing row that carries no scope is a row nothing can be resumed or swept from. Pass the second constructor argument. Refusing rather than returning rows stamped with a guessed tenant.',
				details: { baseDir: this.config.baseDir },
			})
		}

		// A listing is scoped, not addressed: a query for another tenant is a
		// question this tree has no rows for, not an isolation violation. Same
		// reasoning `SessionStore.listSessions` already states for sessions
		// that happen to share a thread id across tenants.
		if (
			scope.tenantId !== attribution.tenantId ||
			(scope.projectId !== undefined && scope.projectId !== attribution.projectId) ||
			(scope.sessionId !== undefined && scope.sessionId !== attribution.sessionId)
		) {
			return { entries: [] }
		}

		const now = options?.now ?? Date.now()
		const entries: DurableRunEntry[] = []

		for (const runId of await this.readRunDirs(this.config.baseDir)) {
			const runDir = join(this.config.baseDir, runId)

			const own = toDurableRunEntry({ ...attribution, runId }, await readCheckpointsIn(runDir), now)
			if (own) entries.push(await this.withClaim(own, runDir, now))

			for (const childId of await this.readRunDirs(join(runDir, 'children'))) {
				const childDir = join(runDir, 'children', childId)
				const child = toDurableRunEntry(
					{ ...attribution, runId: childId, parentRunId: runId },
					await readCheckpointsIn(childDir),
					now,
				)
				if (child) entries.push(await this.withClaim(child, childDir, now))
			}
		}

		return paginateDurableRuns(entries, options)
	}

	/**
	 * Attach the run's claim to its listing row, judged against the page's
	 * own clock so one page cannot disagree with itself about availability.
	 */
	private async withClaim(
		entry: DurableRunEntry,
		runDir: string,
		now: number,
	): Promise<DurableRunEntry> {
		const claim = await readClaim(runDir)
		return claim ? { ...entry, claim: toClaimSummary(claim, now) } : entry
	}

	/** Directory names under `dir`, or none when `dir` does not exist. */
	private async readRunDirs(dir: string): Promise<RunId[]> {
		try {
			const found = await readdir(dir, { withFileTypes: true })
			return found.filter((e) => e.isDirectory()).map((e) => e.name as RunId)
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
			throw err
		}
	}
}
