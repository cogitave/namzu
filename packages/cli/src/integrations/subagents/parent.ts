import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { type ProjectId, asProjectId } from '@namzu/sdk'
import type { RunScope } from '../../tui/agent.js'
import { sessionDatabasePath, sessionStore } from '../sessions/database.js'
import { CliPathBuilder } from '../sessions/paths.js'
import type { SubagentParent } from './runtime.js'

/** Central Projects must exist; embedded sessions without a state root use their supplied scope. */
export async function resolveSubagentParent(
	scope: RunScope,
	cwd: string,
	stateRoot?: string,
): Promise<SubagentParent> {
	if (stateRoot && !existsSync(sessionDatabasePath(stateRoot)))
		throw new Error(`Delegation project ${scope.projectId} is missing`)
	const store = stateRoot ? sessionStore(stateRoot, true) : undefined
	const project = await store?.getProject(scope.projectId, scope.tenantId)
	if (store && !project) throw new Error(`Delegation project ${scope.projectId} is missing`)
	const session = await store?.getSession(scope.sessionId, scope.tenantId)
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

/** Child artifacts share the real Project, without claiming to be resumable CLI conversations. */
export class SubagentPathBuilder extends CliPathBuilder {
	constructor(
		private readonly projectStateRoot: string,
		private readonly projectId: ProjectId,
	) {
		super(projectStateRoot)
		asProjectId(projectId)
	}

	override projectDir(projectId: ProjectId): string {
		if (asProjectId(projectId) !== this.projectId)
			throw new Error('Child path belongs to another project')
		return this.projectStateRoot
	}
}
