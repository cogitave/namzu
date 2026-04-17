/**
 * Single-recipient handoff flow — `idle → locked → CAS → commit | revert`.
 *
 * See session-hierarchy.md §6.1 (single-recipient flow) and §6.4 (concurrent
 * CAS). Function-based per Convention #9 — dependencies arrive as an
 * explicit `deps` envelope so tests can inject mocks and production code
 * composes flows without a class hierarchy.
 *
 * Flow (pattern doc §5.1 + §6.1):
 *   1. Load source session; verify tenant.
 *   2. Check status (must be `idle`); no non-terminal Runs.
 *   3. Validate capacity (depth + width).
 *   4. Transition source `idle → locked` with CAS on `ownerVersion`.
 *   5. Emit `onLocked`.
 *   6. Spawn recipient sub-session + provision isolated workspace.
 *   7. On any step 6 failure: compensating revert (`locked → idle`, version
 *      unchanged, dispose any partial worktree), emit `onUnlocked`, rethrow.
 *   8. On success: commit `locked → idle` with updated `currentActor` +
 *      appended `previousActors` + bumped `ownerVersion`.
 *   9. Emit `onCommitted` with the new version.
 */

import type { SessionId, TenantId } from '../../types/ids/index.js'
import type { SessionStore } from '../../types/session/store.js'
import { TenantIsolationError } from '../errors.js'
import type { Session } from '../hierarchy/session.js'
import type { WorkspaceBackendDriver } from '../workspace/driver.js'
import type { WorkspaceRef } from '../workspace/ref.js'
import type { WorkspaceBackendRegistry } from '../workspace/registry.js'
import type { HandoffAssignment, HandoffOutcome } from './assignment.js'
import type { CapacityValidator } from './capacity.js'
import type { HandoffEventSink } from './events.js'
import { HandoffLockRejected, HandoffVersionConflict } from './version.js'

/**
 * Minimal surface the handoff flow queries for Run fan-in status. A Run is
 * considered "blocking" if it is in any non-terminal status that prevents the
 * source session from transitioning to `locked` (session-hierarchy.md §5.1).
 *
 * The flow injects the resolver so Phase 4 stays decoupled from Phase 6's
 * Run persistence refactor. Production wires the real Run store; tests stub.
 */
export interface RunStatusResolver {
	/**
	 * Returns the reason the session has a non-terminal Run, or `null` when
	 * all Runs are terminal and the lock is allowed.
	 */
	blockingRun(
		sessionId: SessionId,
		tenantId: TenantId,
	): Promise<{ reason: 'active_run' | 'pending_hitl' | 'pending_subsession' } | null>
}

/** Null resolver — treats every session as unblocked. Used by tests that do not exercise Run fan-in. */
export const NOOP_RUN_STATUS_RESOLVER: RunStatusResolver = {
	async blockingRun(): Promise<null> {
		return null
	},
}

export interface SingleHandoffDeps {
	store: SessionStore
	workspaceRegistry: WorkspaceBackendRegistry
	capacity: CapacityValidator
	events: HandoffEventSink
	runStatus?: RunStatusResolver
}

/**
 * Executes a single-recipient handoff against `deps.store`. Throws
 * {@link HandoffLockRejected}, {@link HandoffVersionConflict},
 * {@link TenantIsolationError}, or {@link DelegationCapacityExceeded} on
 * invariant violations. Workspace provisioning failures surface as
 * {@link WorkspaceBackendError} after the compensating revert.
 */
export async function executeSingleHandoff(
	deps: SingleHandoffDeps,
	assignment: HandoffAssignment,
	tenantId: TenantId,
): Promise<HandoffOutcome> {
	if (assignment.tenantId !== tenantId) {
		throw new TenantIsolationError({
			requested: tenantId,
			resource: `handoff-assignment(${assignment.id})`,
		})
	}

	// 1. Load source session + tenant check.
	const source = await deps.store.getSession(assignment.sourceSessionId, tenantId)
	if (!source) {
		throw new Error(`Source session ${assignment.sourceSessionId} not found`)
	}
	if (source.tenantId !== tenantId) {
		throw new TenantIsolationError({
			requested: tenantId,
			resource: `session(${source.id})`,
		})
	}
	if (source.projectId !== assignment.projectId) {
		throw new Error(
			`Assignment projectId ${assignment.projectId} does not match source session projectId ${source.projectId}`,
		)
	}

	// 2. Status check — only `idle` sessions may lock. `active`, `awaiting_hitl`,
	//    `awaiting_merge`, `locked`, `failed`, `archived` all reject.
	if (source.status !== 'idle') {
		throw new HandoffLockRejected({
			sessionId: source.id,
			reason: statusToLockReason(source.status),
		})
	}

	// 3. Non-terminal Run fan-in (§5.1).
	const runResolver = deps.runStatus ?? NOOP_RUN_STATUS_RESOLVER
	const blocking = await runResolver.blockingRun(source.id, tenantId)
	if (blocking) {
		throw new HandoffLockRejected({
			sessionId: source.id,
			reason: blocking.reason,
		})
	}

	// 4. Capacity — depth (new child depth = parent ancestry length + 1) and
	//    width (one new child under the source's *parent* would change — but
	//    single handoff does NOT create a child under the source; it transfers
	//    ownership of the same session. Width only applies to broadcast).
	//    For `single` we still validate depth to future-proof should the flow
	//    evolve into a branch variant.
	const project = await deps.store.getProject(source.projectId, tenantId)
	if (!project) {
		throw new Error(`Project ${source.projectId} not found`)
	}
	await deps.capacity.validateDepth(source.id, project.config.maxDelegationDepth, tenantId)

	// 5. CAS → `idle → locked`.
	if (source.ownerVersion !== assignment.expectedOwnerVersion) {
		throw new HandoffVersionConflict({
			sessionId: source.id,
			expected: assignment.expectedOwnerVersion,
			actual: source.ownerVersion,
		})
	}

	const locked: Session = {
		...source,
		status: 'locked',
	}
	await deps.store.updateSession(locked, tenantId)
	emit(deps.events.onLocked, { sessionId: source.id, at: new Date() })

	// 6. Provision recipient resources. Track partial state for rollback.
	let provisionedWorkspace: WorkspaceRef | null = null
	let createdSessionId: SessionId | null = null
	try {
		const driver: WorkspaceBackendDriver = deps.workspaceRegistry.get('git-worktree')
		provisionedWorkspace = await driver.create({ label: `handoff-${assignment.id}` })

		const recipientSession = await deps.store.createSession(
			{ projectId: source.projectId, currentActor: assignment.recipientActor },
			tenantId,
		)
		createdSessionId = recipientSession.id

		await deps.store.createSubSession(
			{
				parentSessionId: source.id,
				childSessionId: recipientSession.id,
				kind: 'user_handoff',
				spawnedBy: assignment.sourceActor,
			},
			tenantId,
		)

		// 7. Commit source: `locked → idle` with appended actor + bumped version.
		//    The source transitions ownership to the recipient — the previous
		//    owner is permanently read-only (§6.1).
		const committed: Session = {
			...source,
			status: 'idle',
			currentActor: assignment.recipientActor,
			previousActors: source.currentActor
				? [...source.previousActors, source.currentActor]
				: [...source.previousActors],
			ownerVersion: source.ownerVersion + 1,
		}
		await deps.store.updateSession(committed, tenantId)

		emit(deps.events.onCommitted, {
			sessionId: source.id,
			newVersion: committed.ownerVersion,
			handoffIds: [assignment.id],
			at: new Date(),
		})

		return {
			assignmentId: assignment.id,
			newSessionId: recipientSession.id,
			workspaceId: provisionedWorkspace.id,
			committedOwnerVersion: committed.ownerVersion,
		}
	} catch (failure) {
		// Compensating revert — idempotent. Every step tolerates prior success.
		await revertLock(deps, source, provisionedWorkspace, createdSessionId, tenantId)
		throw failure
	}
}

/**
 * Reverts a source session from `locked` back to `idle` preserving
 * `ownerVersion`, disposes any provisioned worktree, and emits `onUnlocked`.
 *
 * **Idempotent.** Every sub-op tolerates being called against already-released
 * state:
 *   - `updateSession` replays the same payload — last-write-wins (Phase 3
 *     store uses write-tmp-rename).
 *   - `dispose` on a missing worktree is a no-op by contract
 *     (`driver.ts#dispose` + `git-worktree.ts` regex for "not a working tree").
 */
async function revertLock(
	deps: SingleHandoffDeps,
	source: Session,
	workspace: WorkspaceRef | null,
	createdSessionId: SessionId | null,
	tenantId: TenantId,
): Promise<void> {
	const reverted: Session = { ...source, status: 'idle' }
	try {
		await deps.store.updateSession(reverted, tenantId)
	} catch {
		// Swallow — the flow is already unwinding a primary failure; surfacing
		// secondary errors would mask root cause. Idempotent per Risk #3.
	}

	if (workspace) {
		try {
			const driver = deps.workspaceRegistry.get('git-worktree')
			await driver.dispose(workspace)
		} catch {
			// Idempotent rollback per Risk #3 — dispose is already tolerant of
			// missing worktrees, but we still guard the registry lookup path.
		}
	}

	if (createdSessionId) {
		// No `deleteSession` in the Phase 3 store surface — mark the partially
		// created recipient session as `archived` so it is inert. A later phase
		// introduces explicit deletion; until then this is the cleanest
		// compensator that does not add surface area.
		try {
			const recipient = await deps.store.getSession(createdSessionId, tenantId)
			if (recipient) {
				await deps.store.updateSession({ ...recipient, status: 'archived' }, tenantId)
			}
		} catch {
			// Same rationale as above.
		}
	}

	emit(deps.events.onUnlocked, { sessionId: source.id, at: new Date() })
}

function statusToLockReason(
	status: Session['status'],
): 'active_run' | 'pending_hitl' | 'pending_subsession' {
	switch (status) {
		case 'active':
			return 'active_run'
		case 'awaiting_hitl':
			return 'pending_hitl'
		case 'awaiting_merge':
			return 'pending_subsession'
		case 'locked':
			return 'active_run'
		case 'failed':
			return 'active_run'
		case 'archived':
			return 'active_run'
		case 'idle':
			// Unreachable — caller guards. Keep a sentinel value so exhaustiveness
			// does not force an `assert never` export from this module.
			return 'active_run'
	}
}

function emit<T>(handler: ((ev: T) => void) | undefined, event: T): void {
	if (handler) handler(event)
}
