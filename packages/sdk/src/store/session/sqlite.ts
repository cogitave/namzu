import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import {
	ProjectRootPathTakenError,
	StaleProjectError,
	StaleSessionError,
	TenantIsolationError,
} from '../../session/errors.js'
import { SessionAlreadySummarizedError } from '../../session/summary/errors.js'
import type {
	MessageId,
	ProjectId,
	SessionId,
	SubSessionId,
	TenantId,
	TopicId,
} from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'
import type { Project, ProjectStatus } from '../../types/project/entity.js'
import type { Session } from '../../types/session/entity.js'
import type { SessionMessage } from '../../types/session/messages.js'
import type {
	CreateProjectParams,
	CreateSessionParams,
	CreateSubSessionParams,
	ProjectConfigInput,
	SessionStore,
	SessionView,
} from '../../types/session/store.js'
import type { SubSession } from '../../types/session/sub-session.js'
import type { SessionSummaryRef } from '../../types/summary/ref.js'
import {
	asProjectId,
	asSessionId,
	asSubSessionId,
	asTenantId,
	asTopicId,
	generateMessageId,
	generateProjectId,
	generateSessionId,
	generateSubSessionId,
} from '../../utils/id.js'
import { canonicalizePath } from './canonical-path.js'
import { type LinkageView, getAncestry, getChildren, orderChildren } from './linkage.js'

export interface SqliteSessionStoreConfig {
	/** Absolute SQLite filename. Parent privacy is owned by the host. Requires Node 22.13+. */
	readonly databasePath: string
	/** Inspection never creates a database, changes its schema, or creates journal sidecars. */
	readonly readOnly?: boolean
}

type Table = 'projects' | 'sessions' | 'subsessions' | 'summaries'
type Row = { body: string; tenant_id: string }
const SCHEMA_VERSION = 1
const SCHEMA = `
CREATE TABLE projects (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, root_path TEXT, created_at INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(tenant_id, root_path));
CREATE TABLE sessions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), topic_id TEXT NOT NULL, created_at INTEGER NOT NULL, body TEXT NOT NULL);
CREATE INDEX sessions_project ON sessions(tenant_id, project_id, created_at, id);
CREATE INDEX sessions_topic ON sessions(tenant_id, topic_id, created_at, id);
CREATE TABLE subsessions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, parent_id TEXT NOT NULL REFERENCES sessions(id), child_id TEXT NOT NULL REFERENCES sessions(id), body TEXT NOT NULL);
CREATE INDEX subsessions_parent ON subsessions(tenant_id, parent_id);
CREATE INDEX subsessions_child ON subsessions(tenant_id, child_id);
CREATE TABLE summaries (id TEXT PRIMARY KEY REFERENCES sessions(id), tenant_id TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), kind TEXT NOT NULL CHECK(kind IN ('message','replacement')), body TEXT NOT NULL);
CREATE INDEX messages_session ON messages(session_id, seq);
CREATE INDEX messages_replacement ON messages(session_id, kind, seq);
`

/**
 * Indexed session metadata and append-only conversation records in one database.
 * Operations own short-lived connections; no connection survives an await or
 * needs a finalizer. Writes and CAS checks share one SQLite transaction, including
 * across processes. Run transcripts and artifacts remain owned by RunStore.
 */
export class SqliteSessionStore implements SessionStore {
	readonly databasePath: string
	private readonly readOnly: boolean

	constructor(config: SqliteSessionStoreConfig) {
		this.databasePath = resolve(config.databasePath)
		this.readOnly = config.readOnly === true
	}

	private use<T>(write: boolean, operation: (db: DatabaseSync) => T): T {
		if (write && this.readOnly) throw new Error('Session database is read-only')
		// Loading the optional driver must not make importing the SDK require SQLite.
		let Database: typeof DatabaseSync
		try {
			Database = (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'))
				.DatabaseSync
		} catch (error) {
			throw new Error('SqliteSessionStore requires Node.js 22.13 or newer.', { cause: error })
		}
		if (!this.readOnly) mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 })
		const db = new Database(this.databasePath, { readOnly: this.readOnly })
		try {
			db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
			const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
			if (version !== 0 && version !== SCHEMA_VERSION)
				throw new Error(`Unsupported session database version ${version}`)
			if (version === 0) {
				if (this.readOnly) throw new Error('Session database has not been initialized')
				db.exec('BEGIN IMMEDIATE')
				try {
					// Another first opener may have initialized it while we waited.
					const current = Number(db.prepare('PRAGMA user_version').get()?.user_version)
					if (current === 0) db.exec(`${SCHEMA} PRAGMA user_version = ${SCHEMA_VERSION};`)
					else if (current !== SCHEMA_VERSION)
						throw new Error(`Unsupported session database version ${current}`)
					db.exec('COMMIT')
				} catch (error) {
					db.exec('ROLLBACK')
					throw error
				}
			}
			if (!this.readOnly) db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;')
			db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
			try {
				const result = operation(db)
				db.exec('COMMIT')
				return result
			} catch (error) {
				db.exec('ROLLBACK')
				throw error
			}
		} finally {
			db.close()
		}
	}

	private get<T>(db: DatabaseSync, table: Table, id: string, tenantId: TenantId): T | null {
		asTenantId(tenantId)
		const row = db.prepare(`SELECT body, tenant_id FROM ${table} WHERE id = ?`).get(id) as
			| Row
			| undefined
		if (!row) return null
		if (row.tenant_id !== tenantId)
			throw new TenantIsolationError({ requested: tenantId, resource: `${table}(${id})` })
		return decode<T>(row.body)
	}

	private requiredSession(db: DatabaseSync, id: SessionId, tenant: TenantId): Session {
		const session = this.get<Session>(db, 'sessions', asSessionId(id), tenant)
		if (!session) throw new Error(`Session ${id} not found`)
		return session
	}

	async createProject(params: CreateProjectParams, tenantId: TenantId): Promise<Project> {
		if (params.tenantId !== tenantId)
			throw new TenantIsolationError({ requested: tenantId, resource: 'project payload' })
		asTenantId(tenantId)
		const rootPath =
			params.rootPath === undefined ? undefined : await canonicalizePath(params.rootPath)
		return this.use(true, (db) => {
			if (rootPath !== undefined) {
				const existing = db
					.prepare('SELECT id FROM projects WHERE tenant_id = ? AND root_path = ?')
					.get(tenantId, rootPath)
				if (existing)
					throw new ProjectRootPathTakenError({
						rootPath,
						existingProjectId: asProjectId(String(existing.id)),
					})
			}
			const now = new Date()
			const project: Project = {
				id: generateProjectId(),
				tenantId,
				name: params.name,
				config: {
					maxDelegationDepth: params.config?.maxDelegationDepth ?? 4,
					maxDelegationWidth: params.config?.maxDelegationWidth ?? 8,
					maxInterventionDepth: 10,
				},
				status: 'open',
				ownerVersion: 0,
				...(rootPath === undefined ? {} : { rootPath }),
				createdAt: now,
				updatedAt: now,
			}
			db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run(
				project.id,
				tenantId,
				rootPath ?? null,
				now.getTime(),
				encode(project),
			)
			return project
		})
	}

	async findProjectByRootPath(rootPath: string, tenantId: TenantId): Promise<Project | null> {
		const canonical = await canonicalizePath(rootPath)
		return this.use(false, (db) => {
			const row = db
				.prepare('SELECT body FROM projects WHERE tenant_id = ? AND root_path = ?')
				.get(asTenantId(tenantId), canonical)
			return row ? decode<Project>(String(row.body)) : null
		})
	}

	async getProject(id: ProjectId, tenant: TenantId): Promise<Project | null> {
		return this.use(false, (db) => this.get<Project>(db, 'projects', asProjectId(id), tenant))
	}

	async updateProject(
		id: ProjectId,
		config: ProjectConfigInput,
		tenant: TenantId,
	): Promise<Project | null> {
		return this.use(true, (db) => {
			const old = this.get<Project>(db, 'projects', asProjectId(id), tenant)
			if (!old) return null
			const project = {
				...old,
				config: {
					...old.config,
					...(config.maxDelegationDepth === undefined
						? {}
						: { maxDelegationDepth: config.maxDelegationDepth }),
					...(config.maxDelegationWidth === undefined
						? {}
						: { maxDelegationWidth: config.maxDelegationWidth }),
				},
				updatedAt: new Date(),
			}
			db.prepare('UPDATE projects SET body = ? WHERE id = ?').run(encode(project), id)
			return project
		})
	}

	async setProjectStatus(
		id: ProjectId,
		status: ProjectStatus,
		tenant: TenantId,
		expectedOwnerVersion: number,
	): Promise<Project | null> {
		return this.use(true, (db) => {
			const old = this.get<Project>(db, 'projects', asProjectId(id), tenant)
			if (!old) return null
			if (old.ownerVersion !== expectedOwnerVersion)
				throw new StaleProjectError({
					projectId: id,
					expectedOwnerVersion,
					actualOwnerVersion: old.ownerVersion,
				})
			const project = { ...old, status, ownerVersion: old.ownerVersion + 1, updatedAt: new Date() }
			db.prepare('UPDATE projects SET body = ? WHERE id = ?').run(encode(project), id)
			return project
		})
	}

	async listProjects(tenant: TenantId): Promise<readonly Project[]> {
		return this.use(false, (db) =>
			db
				.prepare('SELECT body FROM projects WHERE tenant_id = ? ORDER BY created_at, id')
				.all(asTenantId(tenant))
				.map((r) => decode<Project>(String(r.body))),
		)
	}

	async createSession(params: CreateSessionParams, tenant: TenantId): Promise<Session> {
		return this.use(true, (db) => {
			if (!this.get<Project>(db, 'projects', asProjectId(params.projectId), tenant))
				throw new Error(`Project ${params.projectId} not found`)
			const id = params.id === undefined ? generateSessionId() : asSessionId(params.id)
			if (this.get<Session>(db, 'sessions', id, tenant))
				throw new Error(`Session ${id} already exists`)
			const now = new Date()
			const session: Session = {
				id,
				topicId: asTopicId(params.topicId),
				projectId: params.projectId,
				tenantId: tenant,
				status: 'idle',
				currentActor: params.currentActor,
				previousActors: [],
				workspaceId: null,
				ownerVersion: 0,
				createdAt: now,
				updatedAt: now,
			}
			db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(
				id,
				tenant,
				session.projectId,
				session.topicId,
				now.getTime(),
				encode(session),
			)
			return session
		})
	}

	async getSession(id: SessionId, tenant: TenantId): Promise<Session | null> {
		return this.use(false, (db) => this.get<Session>(db, 'sessions', asSessionId(id), tenant))
	}

	async listSessionsByProject(id: ProjectId, tenant: TenantId): Promise<readonly Session[]> {
		return this.use(false, (db) =>
			db
				.prepare(
					'SELECT body FROM sessions WHERE tenant_id = ? AND project_id = ? ORDER BY created_at, id',
				)
				.all(asTenantId(tenant), asProjectId(id))
				.map((r) => decode<Session>(String(r.body))),
		)
	}

	async listSessionsByTopic(id: TopicId, tenant: TenantId): Promise<readonly Session[]> {
		return this.use(false, (db) =>
			db
				.prepare(
					'SELECT body FROM sessions WHERE tenant_id = ? AND topic_id = ? ORDER BY created_at, id',
				)
				.all(asTenantId(tenant), asTopicId(id))
				.map((r) => decode<Session>(String(r.body))),
		)
	}

	async updateSession(
		session: Session,
		tenant: TenantId,
		expectedOwnerVersion?: number,
	): Promise<void> {
		this.use(true, (db) => {
			const old = this.requiredSession(db, session.id, tenant)
			if (session.tenantId !== tenant)
				throw new TenantIsolationError({ requested: tenant, resource: 'session payload' })
			if (session.projectId !== old.projectId || session.topicId !== old.topicId)
				throw new Error('Session project and topic bindings cannot change')
			if (expectedOwnerVersion !== undefined && old.ownerVersion !== expectedOwnerVersion)
				throw new StaleSessionError({
					sessionId: session.id,
					expectedVersion: expectedOwnerVersion,
					actualVersion: old.ownerVersion,
				})
			db.prepare('UPDATE sessions SET body = ? WHERE id = ?').run(
				encode({ ...session, updatedAt: new Date() }),
				session.id,
			)
		})
	}

	async deleteSession(id: SessionId, tenant: TenantId): Promise<void> {
		this.use(true, (db) => {
			if (!this.get<Session>(db, 'sessions', asSessionId(id), tenant)) return
			if (
				db
					.prepare('SELECT 1 FROM subsessions WHERE parent_id = ? OR child_id = ? LIMIT 1')
					.get(id, id)
			)
				throw new Error(
					`Session ${id} has attached sub-sessions; delete them before deleting the session`,
				)
			db.prepare('DELETE FROM messages WHERE session_id = ?').run(id)
			db.prepare('DELETE FROM summaries WHERE id = ?').run(id)
			db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
		})
	}

	async createSubSession(params: CreateSubSessionParams, tenant: TenantId): Promise<SubSession> {
		return this.use(true, (db) => {
			this.requiredSession(db, params.parentSessionId, tenant)
			this.requiredSession(db, params.childSessionId, tenant)
			const now = new Date()
			const sub: SubSession = {
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
			db.prepare('INSERT INTO subsessions VALUES (?, ?, ?, ?, ?)').run(
				sub.id,
				tenant,
				sub.parentSessionId,
				sub.childSessionId,
				encode(sub),
			)
			return sub
		})
	}

	async getSubSession(id: SubSessionId, tenant: TenantId): Promise<SubSession | null> {
		return this.use(false, (db) =>
			this.get<SubSession>(db, 'subsessions', asSubSessionId(id), tenant),
		)
	}

	async updateSubSession(sub: SubSession, tenant: TenantId): Promise<void> {
		this.use(true, (db) => {
			const old = this.get<SubSession>(db, 'subsessions', asSubSessionId(sub.id), tenant)
			if (!old) throw new Error(`SubSession ${sub.id} not found`)
			if (old.parentSessionId !== sub.parentSessionId || old.childSessionId !== sub.childSessionId)
				throw new Error('Sub-session parent and child bindings cannot change')
			db.prepare('UPDATE subsessions SET body = ? WHERE id = ?').run(
				encode({ ...sub, updatedAt: new Date() }),
				sub.id,
			)
		})
	}

	async deleteSubSession(id: SubSessionId, tenant: TenantId): Promise<void> {
		this.use(true, (db) => {
			if (this.get<SubSession>(db, 'subsessions', asSubSessionId(id), tenant))
				db.prepare('DELETE FROM subsessions WHERE id = ?').run(id)
		})
	}

	async appendMessage(id: SessionId, message: Message, tenant: TenantId): Promise<MessageId> {
		return this.use(true, (db) => {
			this.requiredSession(db, id, tenant)
			const entry: SessionMessage = {
				id: generateMessageId(),
				sessionId: id,
				tenantId: tenant,
				message,
				at: new Date(),
			}
			db.prepare("INSERT INTO messages (session_id, kind, body) VALUES (?, 'message', ?)").run(
				id,
				encode(entry),
			)
			return entry.id
		})
	}

	async replaceMessages(
		id: SessionId,
		messages: readonly Message[],
		tenant: TenantId,
	): Promise<void> {
		this.use(true, (db) => {
			this.requiredSession(db, id, tenant)
			const entries = messages.map(
				(message): SessionMessage => ({
					id: generateMessageId(),
					sessionId: id,
					tenantId: tenant,
					message,
					at: new Date(),
				}),
			)
			db.prepare("INSERT INTO messages (session_id, kind, body) VALUES (?, 'replacement', ?)").run(
				id,
				encode(entries),
			)
		})
	}

	async loadMessages(id: SessionId, tenant: TenantId): Promise<readonly Message[]> {
		return (await this.loadSessionMessages(id, tenant)).map((entry) => entry.message)
	}

	async loadSessionMessages(id: SessionId, tenant: TenantId): Promise<readonly SessionMessage[]> {
		return this.use(false, (db) => {
			if (!this.get<Session>(db, 'sessions', asSessionId(id), tenant)) return []
			const replacement = db
				.prepare(
					"SELECT seq, body FROM messages WHERE session_id = ? AND kind = 'replacement' ORDER BY seq DESC LIMIT 1",
				)
				.get(id)
			const entries = replacement
				? (JSON.parse(String(replacement.body)) as unknown[]).map(decodeMessage)
				: []
			const later = db
				.prepare(
					"SELECT body FROM messages WHERE session_id = ? AND seq > ? AND kind = 'message' ORDER BY seq",
				)
				.all(id, Number(replacement?.seq ?? 0))
			return entries.concat(later.map((row) => decodeMessage(JSON.parse(String(row.body)))))
		})
	}

	private linkage(db: DatabaseSync, tenant: TenantId): LinkageView {
		return {
			findChildSubSessions: (id) =>
				db
					.prepare('SELECT body FROM subsessions WHERE tenant_id = ? AND parent_id = ?')
					.all(tenant, id)
					.map((r) => decode<SubSession>(String(r.body))),
			findParentSubSession: (id) => {
				const row = db
					.prepare(
						'SELECT body FROM subsessions WHERE tenant_id = ? AND child_id = ? ORDER BY id LIMIT 1',
					)
					.get(tenant, id)
				return row ? decode<SubSession>(String(row.body)) : null
			},
		}
	}

	async getChildren(id: SessionId, tenant: TenantId): Promise<readonly SubSession[]> {
		return this.use(false, (db) =>
			this.get<Session>(db, 'sessions', asSessionId(id), tenant)
				? orderChildren(getChildren(this.linkage(db, tenant), id))
				: [],
		)
	}

	async getAncestry(id: SessionId, tenant: TenantId): Promise<readonly SessionId[]> {
		return this.use(false, (db) =>
			this.get<Session>(db, 'sessions', asSessionId(id), tenant)
				? getAncestry(this.linkage(db, tenant), id)
				: [],
		)
	}

	async drill(id: SessionId, tenant: TenantId): Promise<SessionView | null> {
		return this.use(false, (db) => {
			const session = this.get<Session>(db, 'sessions', asSessionId(id), tenant)
			if (!session) return null
			const view = this.linkage(db, tenant)
			return {
				session,
				children: orderChildren(getChildren(view, id)),
				ancestry: getAncestry(view, id),
			}
		})
	}

	async recordSummary(
		summary: SessionSummaryRef & { materializedBy: 'kernel' },
		tenant: TenantId,
	): Promise<void> {
		this.use(true, (db) => {
			if (summary.tenantId !== tenant)
				throw new TenantIsolationError({ requested: tenant, resource: 'summary payload' })
			const session = this.requiredSession(db, summary.sessionRef, tenant)
			const existing = this.get<SessionSummaryRef>(db, 'summaries', summary.sessionRef, tenant)
			if (existing && existing.id !== summary.id)
				throw new SessionAlreadySummarizedError({
					sessionId: session.id,
					existingSummaryId: existing.id,
				})
			if (!existing)
				db.prepare('INSERT INTO summaries VALUES (?, ?, ?)').run(
					session.id,
					tenant,
					encode(summary),
				)
			if (['active', 'locked', 'awaiting_merge'].includes(session.status))
				db.prepare('UPDATE sessions SET body = ? WHERE id = ?').run(
					encode({ ...session, status: 'idle', updatedAt: new Date() }),
					session.id,
				)
		})
	}

	async getSummary(id: SessionId, tenant: TenantId): Promise<SessionSummaryRef | null> {
		return this.use(false, (db) =>
			this.get<SessionSummaryRef>(db, 'summaries', asSessionId(id), tenant),
		)
	}
}

function encode(value: unknown): string {
	return JSON.stringify(value)
}
function decode<T>(body: string): T {
	const value = JSON.parse(body) as Record<string, unknown>
	for (const key of ['createdAt', 'updatedAt', 'spawnedAt', 'archivedAt', 'at']) {
		if (typeof value[key] === 'string') value[key] = new Date(value[key] as string)
	}
	if (Array.isArray(value.keyDecisions)) {
		value.keyDecisions = value.keyDecisions.map((entry) => ({ ...entry, at: new Date(entry.at) }))
	}
	return value as T
}
function decodeMessage(value: unknown): SessionMessage {
	const entry = value as SessionMessage
	return { ...entry, at: new Date(entry.at) }
}
