/**
 * InMemorySessionStore — reference in-memory implementation of
 * {@link SessionStore}.
 *
 * Every accessor takes explicit {@link TenantId} (Convention #17). Any
 * accessor called with a tenantId that does not match the resource's owning
 * tenant throws {@link TenantIsolationError} — there is no fallback
 * (Convention #5 deny-by-default, session-hierarchy.md §12.2).
 */

import { TenantIsolationError } from '../../session/errors.js'
import type { Project } from '../../session/hierarchy/project.js'
import type { Session } from '../../session/hierarchy/session.js'
import type { SubSession } from '../../session/hierarchy/sub-session.js'
import type { MessageId, SessionId, TenantId } from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'
import type { ProjectId, SubSessionId } from '../../types/session/ids.js'
import type {
	CreateProjectParams,
	CreateSessionParams,
	CreateSubSessionParams,
	SessionStore,
	SessionView,
} from '../../types/session/store.js'
import {
	generateMessageId,
	generateProjectId,
	generateSessionId,
	generateSubSessionId,
} from '../../utils/id.js'
import { getAncestry, getChildren, orderChildren } from './linkage.js'
import type { LinkageView } from './linkage.js'
import type { SessionMessage } from './messages.js'

interface ProjectRecord {
	tenantId: TenantId
	project: Project
}

interface SessionRecord {
	tenantId: TenantId
	session: Session
}

interface SubSessionRecord {
	tenantId: TenantId
	subSession: SubSession
}

export class InMemorySessionStore implements SessionStore {
	private readonly projects = new Map<ProjectId, ProjectRecord>()
	private readonly sessions = new Map<SessionId, SessionRecord>()
	private readonly subSessions = new Map<SubSessionId, SubSessionRecord>()
	private readonly messages = new Map<SessionId, SessionMessage[]>()

	// Project CRUD ------------------------------------------------------------

	async createProject(params: CreateProjectParams, tenantId: TenantId): Promise<Project> {
		if (params.tenantId !== tenantId) {
			throw new TenantIsolationError({
				requested: tenantId,
				resource: `project(name=${params.name})`,
			})
		}
		const now = new Date()
		const project: Project = {
			id: generateProjectId(),
			tenantId,
			name: params.name,
			config: {
				maxDelegationDepth: 4,
				maxDelegationWidth: 8,
				maxInterventionDepth: 10,
			},
			createdAt: now,
			updatedAt: now,
		}
		this.projects.set(project.id, { tenantId, project })
		return project
	}

	async getProject(projectId: ProjectId, tenantId: TenantId): Promise<Project | null> {
		const record = this.projects.get(projectId)
		if (!record) return null
		this.assertTenant(record.tenantId, tenantId, `project(${projectId})`)
		return record.project
	}

	// Session CRUD ------------------------------------------------------------

	async createSession(params: CreateSessionParams, tenantId: TenantId): Promise<Session> {
		const projectRecord = this.projects.get(params.projectId)
		if (!projectRecord) {
			throw new Error(`Project ${params.projectId} not found`)
		}
		this.assertTenant(projectRecord.tenantId, tenantId, `project(${params.projectId})`)

		const now = new Date()
		const session: Session = {
			id: generateSessionId(),
			projectId: params.projectId,
			tenantId,
			status: 'idle',
			currentActor: params.currentActor,
			previousActors: [],
			workspaceId: null,
			ownerVersion: 0,
			createdAt: now,
			updatedAt: now,
		}
		this.sessions.set(session.id, { tenantId, session })
		return session
	}

	async getSession(sessionId: SessionId, tenantId: TenantId): Promise<Session | null> {
		const record = this.sessions.get(sessionId)
		if (!record) return null
		this.assertTenant(record.tenantId, tenantId, `session(${sessionId})`)
		return record.session
	}

	async updateSession(session: Session, tenantId: TenantId): Promise<void> {
		const record = this.sessions.get(session.id)
		if (!record) {
			throw new Error(`Session ${session.id} not found`)
		}
		this.assertTenant(record.tenantId, tenantId, `session(${session.id})`)
		if (session.tenantId !== tenantId) {
			throw new TenantIsolationError({
				requested: tenantId,
				resource: `session(${session.id}) payload`,
			})
		}
		this.sessions.set(session.id, { tenantId, session: { ...session, updatedAt: new Date() } })
	}

	// SubSession CRUD ---------------------------------------------------------

	async createSubSession(params: CreateSubSessionParams, tenantId: TenantId): Promise<SubSession> {
		const parentRecord = this.sessions.get(params.parentSessionId)
		if (!parentRecord) {
			throw new Error(`Parent session ${params.parentSessionId} not found`)
		}
		this.assertTenant(parentRecord.tenantId, tenantId, `session(${params.parentSessionId})`)

		const childRecord = this.sessions.get(params.childSessionId)
		if (!childRecord) {
			throw new Error(`Child session ${params.childSessionId} not found`)
		}
		this.assertTenant(childRecord.tenantId, tenantId, `session(${params.childSessionId})`)

		const now = new Date()
		const subSession: SubSession = {
			id: generateSubSessionId(),
			parentSessionId: params.parentSessionId,
			childSessionId: params.childSessionId,
			kind: params.kind,
			status: 'pending',
			spawnedBy: params.spawnedBy,
			spawnedAt: now,
			failureMode: params.failureMode ?? 'delegate',
			completionMode: params.completionMode ?? 'summary_ref',
			workspaceId: null,
			updatedAt: now,
		}
		this.subSessions.set(subSession.id, { tenantId, subSession })
		return subSession
	}

	async getSubSession(subSessionId: SubSessionId, tenantId: TenantId): Promise<SubSession | null> {
		const record = this.subSessions.get(subSessionId)
		if (!record) return null
		this.assertTenant(record.tenantId, tenantId, `sub-session(${subSessionId})`)
		return record.subSession
	}

	async updateSubSession(subSession: SubSession, tenantId: TenantId): Promise<void> {
		const record = this.subSessions.get(subSession.id)
		if (!record) {
			throw new Error(`SubSession ${subSession.id} not found`)
		}
		this.assertTenant(record.tenantId, tenantId, `sub-session(${subSession.id})`)
		this.subSessions.set(subSession.id, {
			tenantId,
			subSession: { ...subSession, updatedAt: new Date() },
		})
	}

	// Messages ----------------------------------------------------------------

	async appendMessage(
		sessionId: SessionId,
		message: Message,
		tenantId: TenantId,
	): Promise<MessageId> {
		const record = this.sessions.get(sessionId)
		if (!record) {
			throw new Error(`Session ${sessionId} not found`)
		}
		this.assertTenant(record.tenantId, tenantId, `session(${sessionId})`)

		const id = generateMessageId()
		const entry: SessionMessage = {
			id,
			sessionId,
			tenantId,
			message,
			at: new Date(),
		}
		const existing = this.messages.get(sessionId)
		if (existing) {
			existing.push(entry)
		} else {
			this.messages.set(sessionId, [entry])
		}
		return id
	}

	async loadMessages(sessionId: SessionId, tenantId: TenantId): Promise<readonly Message[]> {
		const record = this.sessions.get(sessionId)
		if (!record) return []
		this.assertTenant(record.tenantId, tenantId, `session(${sessionId})`)
		const entries = this.messages.get(sessionId) ?? []
		return entries.map((e) => e.message)
	}

	// Linkage -----------------------------------------------------------------

	async getChildren(sessionId: SessionId, tenantId: TenantId): Promise<readonly SubSession[]> {
		const record = this.sessions.get(sessionId)
		if (!record) return []
		this.assertTenant(record.tenantId, tenantId, `session(${sessionId})`)
		return orderChildren(getChildren(this.linkageView(tenantId), sessionId))
	}

	async getAncestry(sessionId: SessionId, tenantId: TenantId): Promise<readonly SessionId[]> {
		const record = this.sessions.get(sessionId)
		if (!record) return []
		this.assertTenant(record.tenantId, tenantId, `session(${sessionId})`)
		return getAncestry(this.linkageView(tenantId), sessionId)
	}

	async drill(sessionId: SessionId, tenantId: TenantId): Promise<SessionView | null> {
		const record = this.sessions.get(sessionId)
		if (!record) return null
		this.assertTenant(record.tenantId, tenantId, `session(${sessionId})`)

		const view = this.linkageView(tenantId)
		return {
			session: record.session,
			children: orderChildren(getChildren(view, sessionId)),
			ancestry: getAncestry(view, sessionId),
		}
	}

	// Helpers -----------------------------------------------------------------

	private assertTenant(actual: TenantId, requested: TenantId, resource: string): void {
		if (actual !== requested) {
			throw new TenantIsolationError({ requested, resource })
		}
	}

	private linkageView(tenantId: TenantId): LinkageView {
		return {
			findChildSubSessions: (parentSessionId) => {
				const matches: SubSession[] = []
				for (const record of this.subSessions.values()) {
					if (record.tenantId !== tenantId) continue
					if (record.subSession.parentSessionId === parentSessionId) {
						matches.push(record.subSession)
					}
				}
				return matches
			},
			findParentSubSession: (childSessionId) => {
				for (const record of this.subSessions.values()) {
					if (record.tenantId !== tenantId) continue
					if (record.subSession.childSessionId === childSessionId) {
						return record.subSession
					}
				}
				return null
			},
		}
	}
}
