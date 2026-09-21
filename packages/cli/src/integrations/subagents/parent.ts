import { basename } from 'node:path'
import type { Project, ProjectId, Session, SessionId, TenantId, TopicId } from '@namzu/sdk'
import type { SubagentParent } from './runtime.js'

/** The conversation a delegation belongs to: the ids its parent turn runs under. */
export interface SubagentParentScope {
	readonly tenantId: TenantId
	readonly projectId: ProjectId
	readonly topicId: TopicId
	readonly sessionId: SessionId
}

/**
 * Where the parent's project and session are recorded, when the host keeps
 * them. A host with no durable record (an embedded session) passes none, and
 * the parent is built from its scope alone.
 */
export interface SubagentParentRecords {
	getProject(projectId: ProjectId, tenantId: TenantId): Promise<Project | null | undefined>
	getSession(sessionId: SessionId, tenantId: TenantId): Promise<Session | null | undefined>
}

/**
 * The parent a delegation is attributed to.
 *
 * With records, the project must exist, the session must not be archived and
 * must belong to that project: a delegation is refused rather than attributed
 * to a conversation that no longer stands for this work. Without records, the
 * scope is trusted and a project with the CLI's delegation limits is
 * described for it.
 */
export async function resolveSubagentParent(
	scope: SubagentParentScope,
	cwd: string,
	records?: SubagentParentRecords,
): Promise<SubagentParent> {
	const project = await records?.getProject(scope.projectId, scope.tenantId)
	if (records && !project) throw new Error(`Delegation project ${scope.projectId} is missing`)
	const session = await records?.getSession(scope.sessionId, scope.tenantId)
	if (session?.status === 'archived')
		throw new Error(`Delegation session ${session.id} is archived`)
	if (session && session.projectId !== scope.projectId) {
		throw new Error('Delegation parent session does not belong to its project')
	}
	const now = new Date()
	return {
		project: project ?? {
			id: scope.projectId,
			tenantId: scope.tenantId,
			name: basename(cwd),
			rootPath: cwd,
			config: { maxDelegationDepth: 4, maxDelegationWidth: 8, maxInterventionDepth: 10 },
			status: 'open',
			ownerVersion: 0,
			createdAt: now,
			updatedAt: now,
		},
		topic: {
			id: session?.topicId ?? scope.topicId,
			projectId: scope.projectId,
			tenantId: scope.tenantId,
			title: 'CLI conversations',
			status: 'open',
			ownerVersion: 0,
			createdAt: now,
			updatedAt: now,
		},
		sessionId: scope.sessionId,
	}
}
