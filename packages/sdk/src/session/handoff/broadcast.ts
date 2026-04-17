/**
 * Multi-recipient (broadcast) handoff — atomic fan-out with compensating
 * rollback.
 *
 * See session-hierarchy.md §6.2 (Multi-recipient broadcast flow — atomic),
 * §5.4 (broadcast source-session post-fan-out), §6.5 (capacity enforcement).
 *
 * **Atomicity contract** — one transaction boundary: either the full fan-out
 * commits (source CAS-lock + N assignments + N sub-sessions + N worktrees),
 * or none of it is externally observable. On any step failure the kernel
 * executes a compensating rollback and emits `onBroadcastRollback` with
 * accurate `partialState` counts. The rollback itself is idempotent per
 * roadmap Risk #3.
 *
 * Commit / rollback sequence (pattern doc §6.2):
 * ```
 * COMMIT:   idle → locked(CAS) → N assignments → N sub-sessions → N worktrees → awaiting_merge
 * ROLLBACK: ( ← tear down partial worktrees ← delete partial sub-sessions ←
 *             delete partial assignments ← release CAS ) emit broadcast.rollback;
 *             source → idle
 * ```
 */

import type { SessionId, TenantId } from '../../types/ids/index.js'
import type { SubSessionId } from '../../types/session/ids.js'
import type { SessionStore } from '../../types/session/store.js'
import { TenantIsolationError } from '../errors.js'
import type { Session } from '../hierarchy/session.js'
import type { WorkspaceBackendDriver } from '../workspace/driver.js'
import type { WorkspaceRef } from '../workspace/ref.js'
import type { WorkspaceBackendRegistry } from '../workspace/registry.js'
import type { HandoffAssignment, HandoffOutcome } from './assignment.js'
import type { CapacityValidator } from './capacity.js'
import type { HandoffEventSink } from './events.js'
import { NOOP_RUN_STATUS_RESOLVER, type RunStatusResolver } from './single.js'
import { HandoffLockRejected, HandoffVersionConflict } from './version.js'

export interface BroadcastHandoffDeps {
	store: SessionStore
	workspaceRegistry: WorkspaceBackendRegistry
	capacity: CapacityValidator
	events: HandoffEventSink
	runStatus?: RunStatusResolver
}

/**
 * Per-recipient partial state tracked during fan-out so rollback can
 * compensate exactly what was created. `subSessionId` is populated at the
 * same step that creates the record so rollback can delete it in reverse
 * order alongside the child session.
 */
interface RecipientPartial {
	assignmentId: HandoffAssignment['id']
	recipientActor: HandoffAssignment['recipientActor']
	workspace: WorkspaceRef | null
	createdSessionId: SessionId | null
	createdSubSessionId: SubSessionId | null
}

/**
 * Executes a broadcast fan-out. All assignments MUST share the same
 * `sourceSessionId`, `expectedOwnerVersion`, `broadcastId`, and `projectId`.
 * Duplicate recipients (same actor kind + id) are rejected before any write.
 *
 * Returns one {@link HandoffOutcome} per recipient on success. On failure the
 * source session is restored, every provisioned resource is torn down, and
 * the underlying error propagates after `onBroadcastRollback` is emitted.
 */
export async function executeBroadcastHandoff(
	deps: BroadcastHandoffDeps,
	assignments: readonly HandoffAssignment[],
	tenantId: TenantId,
): Promise<readonly HandoffOutcome[]> {
	// 1. Shape validation -----------------------------------------------------

	if (assignments.length === 0) {
		throw new Error('executeBroadcastHandoff: assignments must not be empty')
	}
	if (assignments.length === 1) {
		throw new Error(
			'executeBroadcastHandoff: single-recipient handoffs must use executeSingleHandoff',
		)
	}

	const first = assignments[0]
	if (!first) throw new Error('executeBroadcastHandoff: assignments[0] undefined')

	if (first.mode !== 'broadcast') {
		throw new Error(`executeBroadcastHandoff: mode must be 'broadcast' (got '${first.mode}')`)
	}
	if (!first.broadcastId) {
		throw new Error('executeBroadcastHandoff: broadcastId required on every assignment')
	}

	for (const a of assignments) {
		if (a.tenantId !== tenantId) {
			throw new TenantIsolationError({
				requested: tenantId,
				resource: `handoff-assignment(${a.id})`,
			})
		}
		if (a.sourceSessionId !== first.sourceSessionId) {
			throw new Error('executeBroadcastHandoff: all assignments must share sourceSessionId')
		}
		if (a.broadcastId !== first.broadcastId) {
			throw new Error('executeBroadcastHandoff: all assignments must share broadcastId')
		}
		if (a.expectedOwnerVersion !== first.expectedOwnerVersion) {
			throw new Error('executeBroadcastHandoff: all assignments must share expectedOwnerVersion')
		}
		if (a.projectId !== first.projectId) {
			throw new Error('executeBroadcastHandoff: all assignments must share projectId')
		}
		if (a.mode !== 'broadcast') {
			throw new Error('executeBroadcastHandoff: every assignment must have mode="broadcast"')
		}
	}

	// 2. Dedupe recipients — same concern as the collab doc's Codex R: two rows
	//    targeting the same actor would produce duplicate sub-sessions + racy
	//    worktree paths. Reject before any side effect.
	const seen = new Set<string>()
	for (const a of assignments) {
		const key = recipientKey(a.recipientActor)
		if (seen.has(key)) {
			throw new Error(
				`executeBroadcastHandoff: duplicate recipient detected (${key}). Dedupe before submitting.`,
			)
		}
		seen.add(key)
	}

	// 3. Load source + tenant check.
	const source = await deps.store.getSession(first.sourceSessionId, tenantId)
	if (!source) {
		throw new Error(`Source session ${first.sourceSessionId} not found`)
	}
	if (source.tenantId !== tenantId) {
		throw new TenantIsolationError({
			requested: tenantId,
			resource: `session(${source.id})`,
		})
	}
	if (source.projectId !== first.projectId) {
		throw new Error(
			`Assignment projectId ${first.projectId} does not match source projectId ${source.projectId}`,
		)
	}

	// 4. Status check.
	if (source.status !== 'idle') {
		throw new HandoffLockRejected({
			sessionId: source.id,
			reason:
				source.status === 'active'
					? 'active_run'
					: source.status === 'awaiting_hitl'
						? 'pending_hitl'
						: 'pending_subsession',
		})
	}

	// 5. Non-terminal Run fan-in (§5.1).
	const runResolver = deps.runStatus ?? NOOP_RUN_STATUS_RESOLVER
	const blocking = await runResolver.blockingRun(source.id, tenantId)
	if (blocking) {
		throw new HandoffLockRejected({ sessionId: source.id, reason: blocking.reason })
	}

	// 6. Capacity — width + depth. Width covers N new children in one shot
	//    (§6.5); depth covers `source.depth + 1 ≤ maxDepth`.
	const project = await deps.store.getProject(source.projectId, tenantId)
	if (!project) {
		throw new Error(`Project ${source.projectId} not found`)
	}
	await deps.capacity.validateWidth(
		source.id,
		assignments.length,
		project.config.maxDelegationWidth,
		tenantId,
	)
	await deps.capacity.validateDepth(source.id, project.config.maxDelegationDepth, tenantId)

	// 7. CAS → source `idle → locked`.
	if (source.ownerVersion !== first.expectedOwnerVersion) {
		throw new HandoffVersionConflict({
			sessionId: source.id,
			expected: first.expectedOwnerVersion,
			actual: source.ownerVersion,
		})
	}

	const locked: Session = { ...source, status: 'locked' }
	await deps.store.updateSession(locked, tenantId)
	emit(deps.events.onLocked, { sessionId: source.id, at: new Date() })

	// 8. Fan-out provisioning. Track per-recipient partial state so rollback
	//    can compensate precisely.
	const partials: RecipientPartial[] = []
	let assignmentsWritten = 0
	let subsessionsCreated = 0
	let worktreesProvisioned = 0

	try {
		const driver: WorkspaceBackendDriver = deps.workspaceRegistry.get('git-worktree')

		for (const assignment of assignments) {
			// Per-recipient: new isolated workspace → new child session → new
			// sub-session edge. Each sub-op advances the partial-state counters.
			const partial: RecipientPartial = {
				assignmentId: assignment.id,
				recipientActor: assignment.recipientActor,
				workspace: null,
				createdSessionId: null,
				createdSubSessionId: null,
			}
			partials.push(partial)

			partial.workspace = await driver.create({ label: `broadcast-${assignment.id}` })
			worktreesProvisioned += 1

			const childSession = await deps.store.createSession(
				{ projectId: source.projectId, currentActor: assignment.recipientActor },
				tenantId,
			)
			partial.createdSessionId = childSession.id

			const subSession = await deps.store.createSubSession(
				{
					parentSessionId: source.id,
					childSessionId: childSession.id,
					kind: 'user_handoff',
					spawnedBy: assignment.sourceActor,
				},
				tenantId,
			)
			partial.createdSubSessionId = subSession.id
			subsessionsCreated += 1

			// "Assignments written" is the last per-recipient step — counts any
			// recipient whose full row reached store-durable state.
			assignmentsWritten += 1
		}

		// 9. Commit source: `locked → awaiting_merge` (§5.4 — broadcast source is
		//    not `idle` until all recipients terminalize; coordinator role).
		const committed: Session = {
			...source,
			status: 'awaiting_merge',
			ownerVersion: source.ownerVersion + 1,
		}
		await deps.store.updateSession(committed, tenantId)

		emit(deps.events.onCommitted, {
			sessionId: source.id,
			newVersion: committed.ownerVersion,
			handoffIds: assignments.map((a) => a.id),
			at: new Date(),
		})

		return partials.map<HandoffOutcome>((p) => {
			if (!p.workspace || !p.createdSessionId) {
				// Unreachable — success path populates both fields on every partial.
				throw new Error(`Broadcast partial for ${p.assignmentId} missing post-commit fields`)
			}
			return {
				assignmentId: p.assignmentId,
				newSessionId: p.createdSessionId,
				workspaceId: p.workspace.id,
				committedOwnerVersion: committed.ownerVersion,
			}
		})
	} catch (failure) {
		await rollbackBroadcast(deps, source, partials, tenantId, {
			broadcastId: first.broadcastId,
			reason: failure instanceof Error ? failure.message : String(failure),
			assignmentsWritten,
			subsessionsCreated,
			worktreesProvisioned,
		})
		throw failure
	}
}

/**
 * Compensating rollback — idempotent per Risk #3.
 *
 * Order (reverse of commit): tear down worktrees → delete partially created
 * sub-sessions → delete partially created child sessions → release source
 * CAS lock → emit `onBroadcastRollback`. Every sub-op swallows its own
 * secondary error so the primary failure remains the surfaced cause.
 *
 * Phase 8 closed the Phase 4 Known Delta (INTERP #2): previous implementation
 * flipped partial recipient sessions to `status: 'archived'` as a stopgap
 * because the store had no `deleteSession` primitive. The store now exposes
 * `deleteSession` + `deleteSubSession` (idempotent), so rollback is total —
 * no orphan records remain.
 */
async function rollbackBroadcast(
	deps: BroadcastHandoffDeps,
	source: Session,
	partials: readonly RecipientPartial[],
	tenantId: TenantId,
	meta: {
		broadcastId: string
		reason: string
		assignmentsWritten: number
		subsessionsCreated: number
		worktreesProvisioned: number
	},
): Promise<void> {
	// a. Dispose any provisioned worktrees (idempotent by driver contract).
	for (const partial of partials) {
		if (!partial.workspace) continue
		try {
			const driver = deps.workspaceRegistry.get('git-worktree')
			await driver.dispose(partial.workspace)
		} catch {
			// Idempotent — secondary failure must not mask the primary one.
		}
	}

	// b. Delete any partially created sub-sessions (reverse order of creation
	//    so child-side constraints release before the session below them).
	for (const partial of partials) {
		if (!partial.createdSubSessionId) continue
		try {
			await deps.store.deleteSubSession(partial.createdSubSessionId, tenantId)
		} catch {
			// Idempotent.
		}
	}

	// c. Delete partially created recipient sessions (total cleanup — pattern
	//    doc §6.2: fan-out is atomic, partial state is externally
	//    unobservable).
	for (const partial of partials) {
		if (!partial.createdSessionId) continue
		try {
			await deps.store.deleteSession(partial.createdSessionId, tenantId)
		} catch {
			// Idempotent.
		}
	}

	// d. Release source CAS — `locked → idle`, preserving ownerVersion.
	try {
		const reverted: Session = { ...source, status: 'idle' }
		await deps.store.updateSession(reverted, tenantId)
	} catch {
		// Idempotent — the write-tmp-rename primitive is itself idempotent
		// against the same payload.
	}

	emit(deps.events.onBroadcastRollback, {
		sessionId: source.id,
		broadcastId: meta.broadcastId,
		reason: meta.reason,
		partialState: {
			assignmentsWritten: meta.assignmentsWritten,
			subsessionsCreated: meta.subsessionsCreated,
			worktreesProvisioned: meta.worktreesProvisioned,
		},
		at: new Date(),
	})
}

function recipientKey(actor: HandoffAssignment['recipientActor']): string {
	switch (actor.kind) {
		case 'user':
			return `user:${actor.userId}`
		case 'agent':
			return `agent:${actor.agentId}`
		case 'system':
			return `system:${actor.role}`
	}
}

function emit<T>(handler: ((ev: T) => void) | undefined, event: T): void {
	if (handler) handler(event)
}
