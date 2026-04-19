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
import { SessionAlreadySummarizedError } from '../../session/summary/ref.js'
import type { SessionSummaryRef } from '../../session/summary/ref.js'
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

interface SummaryRecord {
	tenantId: TenantId
	summary: SessionSummaryRef
}

/**
 * Non-terminal statuses from which {@link InMemorySessionStore.recordSummary}
 * flips the owning session to `'idle'` as part of the atomic materialize +
 * transition contract (session-hierarchy.md §8.1). Other statuses — already
 * terminal or awaiting HITL — are left untouched.
 */
const SUMMARY_TERMINAL_FLIP_STATUSES: ReadonlySet<Session['status']> = new Set([
	'active',
	'locked',
	'awaiting_merge',
])

export class InMemorySessionStore implements SessionStore {
	private readonly projects = new Map<ProjectId, ProjectRecord>()
	private readonly sessions = new Map<SessionId, SessionRecord>()
	private readonly subSessions = new Map<SubSessionId, SubSessionRecord>()
	private readonly messages = new Map<SessionId, SessionMessage[]>()
	private readonly summaries = new Map<SessionId, SummaryRecord>()

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
			threadId: params.threadId,
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

	async deleteSession(sessionId: SessionId, tenantId: TenantId): Promise<void> {
		const record = this.sessions.get(sessionId)
		if (!record) return // Idempotent: missing = no-op.
		this.assertTenant(record.tenantId, tenantId, `session(${sessionId})`)

		// Policy: reject if sub-sessions still attach to this session (either as
		// parent or child). Callers must delete children first — Convention #5
		// deny-by-default; no implicit cascade.
		for (const subRecord of this.subSessions.values()) {
			const { subSession } = subRecord
			if (subSession.parentSessionId === sessionId || subSession.childSessionId === sessionId) {
				throw new Error(
					`Session ${sessionId} has attached sub-sessions; delete them before deleting the session`,
				)
			}
		}

		this.sessions.delete(sessionId)
		this.messages.delete(sessionId)
		this.summaries.delete(sessionId)
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

	async deleteSubSession(subSessionId: SubSessionId, tenantId: TenantId): Promise<void> {
		const record = this.subSessions.get(subSessionId)
		if (!record) return // Idempotent: missing = no-op.
		this.assertTenant(record.tenantId, tenantId, `sub-session(${subSessionId})`)
		this.subSessions.delete(subSessionId)
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

	async loadSessionMessages(
		sessionId: SessionId,
		tenantId: TenantId,
	): Promise<readonly SessionMessage[]> {
		const record = this.sessions.get(sessionId)
		if (!record) return []
		this.assertTenant(record.tenantId, tenantId, `session(${sessionId})`)
		const entries = this.messages.get(sessionId) ?? []
		// Return a shallow copy so callers cannot mutate the internal log.
		return entries.map((e) => ({ ...e }))
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

	// Summary (§4.7 / §8.1) ---------------------------------------------------

	async recordSummary(
		summary: SessionSummaryRef & { materializedBy: 'kernel' },
		tenantId: TenantId,
	): Promise<void> {
		if (summary.tenantId !== tenantId) {
			throw new TenantIsolationError({
				requested: tenantId,
				resource: `summary(${summary.id}) payload`,
			})
		}
		const sessionRecord = this.sessions.get(summary.sessionRef)
		if (!sessionRecord) {
			throw new Error(`Session ${summary.sessionRef} not found`)
		}
		this.assertTenant(sessionRecord.tenantId, tenantId, `session(${summary.sessionRef})`)

		// Atomic within the call: summary persist + session status flip commit
		// together. An existing summary with the same id is the recovery path —
		// idempotently replay the status flip without duplicating the record.
		const existing = this.summaries.get(summary.sessionRef)
		if (existing && existing.summary.id !== summary.id) {
			throw new SessionAlreadySummarizedError({
				sessionId: summary.sessionRef,
				existingSummaryId: existing.summary.id,
			})
		}

		if (!existing) {
			this.summaries.set(summary.sessionRef, { tenantId, summary })
		}

		if (SUMMARY_TERMINAL_FLIP_STATUSES.has(sessionRecord.session.status)) {
			this.sessions.set(summary.sessionRef, {
				tenantId,
				session: {
					...sessionRecord.session,
					status: 'idle',
					updatedAt: new Date(),
				},
			})
		}
	}

	async getSummary(sessionId: SessionId, tenantId: TenantId): Promise<SessionSummaryRef | null> {
		const record = this.summaries.get(sessionId)
		if (!record) return null
		this.assertTenant(record.tenantId, tenantId, `summary(${record.summary.id})`)
		return record.summary
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
