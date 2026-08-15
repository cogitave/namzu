/**
 * ProjectManager — open/close a workspace, and the gate the ingress paths read.
 *
 * This is the Thread archival model moved to the level that survives. Thread
 * carried `status` and `TopicManager.requireOpen`; Project — the thing a
 * tenant actually owns, configures, and closes — carried nothing, so archiving
 * a workspace meant nothing to the code. See the hierarchy plan.
 *
 * Two deliberate differences from the Thread version:
 *
 *   - Status moves **both ways**. A thread was archived forever; a workspace is
 *     long-lived and a mistaken close should be recoverable.
 *   - The gate is a **function over a store**, not a method on an injected
 *     manager. The three ingress paths already hold a `SessionStore`, so
 *     nothing has to be threaded through a constructor for the invariant to be
 *     enforced — a gate that requires new wiring is a gate somebody forgets to
 *     wire.
 */

import {
	PROJECT_NOT_EMPTY_SAMPLE_LIMIT,
	ProjectClosedError,
	ProjectNotEmptyError,
} from '../../session/errors.js'
import type { TenantId } from '../../types/ids/index.js'
import type { Project } from '../../types/project/entity.js'
import type { SessionStatus } from '../../types/session/entity.js'
import type { ProjectId } from '../../types/session/ids.js'
import type { SessionStore } from '../../types/session/store.js'

/**
 * Session statuses that block a workspace from closing.
 *
 * A live session is a running agent. Closing its workspace out from under it
 * would strand work whose owner is still watching, so the caller settles the
 * sessions first and archival never cascades.
 */
const ARCHIVAL_BLOCKING_STATUSES: ReadonlySet<SessionStatus> = new Set([
	'active',
	'locked',
	'awaiting_merge',
	'awaiting_hitl',
])

/**
 * Load a Project and assert it accepts new work.
 *
 * Throws on absence — a missing project is a hard error, not an assumed-open
 * one — and {@link ProjectClosedError} on an archived project. Returns the
 * loaded Project so the caller can skip a second read; every current caller
 * needs `config` immediately afterwards.
 *
 * `op` names the operation in the error, because "archived" is not by itself
 * an explanation of what the caller was refused.
 */
export async function requireOpenProject(
	store: Pick<SessionStore, 'getProject'>,
	projectId: ProjectId,
	tenantId: TenantId,
	op: string,
): Promise<Project> {
	const project = await store.getProject(projectId, tenantId)
	if (!project) {
		throw new Error(`Project ${projectId} not found for tenant ${tenantId} — ${op} rejected`)
	}
	if (project.status === 'archived') {
		throw new ProjectClosedError({ projectId, op })
	}
	return project
}

export interface ProjectManagerDeps {
	store: SessionStore
}

export class ProjectManager {
	constructor(private readonly deps: ProjectManagerDeps) {}

	/** See {@link requireOpenProject}. */
	requireOpen(projectId: ProjectId, tenantId: TenantId, op = 'require-open'): Promise<Project> {
		return requireOpenProject(this.deps.store, projectId, tenantId, op)
	}

	/**
	 * Close a workspace.
	 *
	 * Refuses while any attached session is non-terminal
	 * ({@link ARCHIVAL_BLOCKING_STATUSES}), throwing {@link ProjectNotEmptyError}
	 * with a sample of what is blocking. The presence check runs **before** the
	 * already-archived short-circuit, so a workspace that is archived and still
	 * harbouring a live session reports the live session rather than reporting
	 * success — the second call is where an operator finds out.
	 *
	 * Idempotent: re-archiving an empty archived project is a no-op that
	 * returns the stored record without a write, so it does not burn a version
	 * and cannot lose a race it is not in.
	 */
	async archive(projectId: ProjectId, tenantId: TenantId): Promise<Project> {
		const project = await this.deps.store.getProject(projectId, tenantId)
		if (!project) {
			throw new Error(`Project ${projectId} not found for tenant ${tenantId} — archive rejected`)
		}

		// An unanswerable precondition is a refusal, not an empty answer.
		//
		// This read used to be `?? []`, which turned "this store cannot tell me
		// what is running here" into "nothing is running here": a store without
		// the optional method archived the workspace over live sessions and
		// reported success. The whole point of the check is that archival does
		// not cascade over running work, and the check was skippable by any
		// store that had not implemented one optional method.
		//
		// Optional on the interface protects implementors — a host's own store
		// should not stop compiling because the SDK grew a method. It cannot
		// also mean a safety precondition silently passes.
		const listByProject = this.deps.store.listSessionsByProject
		if (!listByProject) {
			throw new Error(
				`Project ${projectId} cannot be archived: this SessionStore does not implement listSessionsByProject, so whether a session is still running in the workspace cannot be established. Implement it, or settle and verify the sessions through your own path before closing the workspace.`,
			)
		}
		const sessions = await listByProject.call(this.deps.store, projectId, tenantId)
		const blocking = sessions.filter((s) => ARCHIVAL_BLOCKING_STATUSES.has(s.status))
		if (blocking.length > 0) {
			throw new ProjectNotEmptyError({
				projectId,
				tenantId,
				op: 'archive',
				blockingSessions: blocking
					.slice(0, PROJECT_NOT_EMPTY_SAMPLE_LIMIT)
					.map((s) => ({ sessionId: s.id, status: s.status })),
				totalBlockingSessions: blocking.length,
			})
		}

		if (project.status === 'archived') return project
		return this.write(projectId, 'archived', tenantId, project.ownerVersion)
	}

	/**
	 * Reopen a workspace. Idempotent in the same way, and unconditional
	 * otherwise: there is nothing a live session could make unsafe about
	 * accepting work again.
	 */
	async reopen(projectId: ProjectId, tenantId: TenantId): Promise<Project> {
		const project = await this.deps.store.getProject(projectId, tenantId)
		if (!project) {
			throw new Error(`Project ${projectId} not found for tenant ${tenantId} — reopen rejected`)
		}
		if (project.status === 'open') return project
		return this.write(projectId, 'open', tenantId, project.ownerVersion)
	}

	private async write(
		projectId: ProjectId,
		status: Project['status'],
		tenantId: TenantId,
		expectedOwnerVersion: number,
	): Promise<Project> {
		const setStatus = this.deps.store.setProjectStatus
		if (!setStatus) {
			throw new Error(
				`Project ${projectId} cannot be set to '${status}': this SessionStore does not implement setProjectStatus. A store without it cannot record the state, and pretending the write succeeded would leave the gate reading 'open' forever.`,
			)
		}
		const written = await setStatus.call(
			this.deps.store,
			projectId,
			status,
			tenantId,
			expectedOwnerVersion,
		)
		if (!written) {
			throw new Error(`Project ${projectId} disappeared during '${status}' write`)
		}
		return written
	}
}
