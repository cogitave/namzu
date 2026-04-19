/**
 * DiskSessionStore — filesystem-backed implementation of
 * {@link SessionStore}.
 *
 * Every mutation is write-tmp-rename (Convention #8). Directory layout
 * matches session-hierarchy.md §7 / §13.4:
 *
 *   {rootDir}/projects/{projectId}/
 *     project.json
 *     sessions/{sessionId}/
 *       session.json
 *       messages.jsonl
 *       subsessions/{subSessionId}/
 *         subsession.json
 *
 * Tenant scoping is enforced through the JSON payload (`tenantId` field on
 * every record) rather than the path layout; cross-tenant reads reject with
 * {@link TenantIsolationError} (Convention #17, session-hierarchy.md §12.2).
 *
 * Constructor takes `rootDir`; migration to the canonical `.namzu/projects/`
 * path lives in Phase 7 of the overall roadmap.
 */

import {
	appendFile,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	unlink,
	writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { TenantIsolationError } from '../../session/errors.js'
import type { Project } from '../../session/hierarchy/project.js'
import type { Session } from '../../session/hierarchy/session.js'
import type { SubSession } from '../../session/hierarchy/sub-session.js'
import type { DeliverableRef } from '../../session/summary/deliverable.js'
import { SessionAlreadySummarizedError } from '../../session/summary/ref.js'
import type {
	SessionSummaryKeyDecision,
	SessionSummaryOutcome,
	SessionSummaryRef,
} from '../../session/summary/ref.js'
import type { MessageId, SessionId, TenantId } from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'
import type { ProjectId, SubSessionId, SummaryId, ThreadId } from '../../types/session/ids.js'
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

/**
 * Config for {@link DiskSessionStore}. `rootDir` is absolute; all files live
 * under it per the layout documented in the module header.
 */
export interface DiskSessionStoreConfig {
	rootDir: string
}

interface PersistedProject {
	id: ProjectId
	tenantId: TenantId
	name: string
	config: Project['config']
	createdAt: string
	updatedAt: string
}

interface PersistedSession {
	id: SessionId
	threadId: ThreadId
	projectId: ProjectId
	tenantId: TenantId
	status: Session['status']
	currentActor: Session['currentActor']
	previousActors: Session['previousActors']
	workspaceId: Session['workspaceId']
	ownerVersion: number
	createdAt: string
	updatedAt: string
}

interface PersistedSubSession {
	id: SubSessionId
	parentSessionId: SessionId
	childSessionId: SessionId
	tenantId: TenantId
	kind: SubSession['kind']
	status: SubSession['status']
	spawnedBy: SubSession['spawnedBy']
	spawnedAt: string
	failureMode: SubSession['failureMode']
	completionMode: SubSession['completionMode']
	workspaceId: SubSession['workspaceId']
	broadcastGroupId?: string
	summaryRef?: SubSession['summaryRef']
	archiveRef?: SubSession['archiveRef']
	archivedAt?: string
	updatedAt: string
}

interface PersistedMessageLine {
	id: MessageId
	sessionId: SessionId
	tenantId: TenantId
	message: Message
	at: string
}

interface PersistedSummary {
	id: SummaryId
	sessionRef: SessionId
	tenantId: TenantId
	outcome: SessionSummaryOutcome
	deliverables: readonly DeliverableRef[]
	agentSummary: string
	keyDecisions: ReadonlyArray<{ at: string; summary: string }>
	at: string
	materializedBy: 'kernel'
}

/**
 * Non-terminal statuses from which {@link DiskSessionStore.recordSummary}
 * flips the owning session to `'idle'` as part of the atomic materialize +
 * transition contract (session-hierarchy.md §8.1).
 */
const SUMMARY_TERMINAL_FLIP_STATUSES: ReadonlySet<Session['status']> = new Set([
	'active',
	'locked',
	'awaiting_merge',
])

/**
 * Index of projectId → its directory path. Built lazily on lookup via
 * {@link DiskSessionStore.resolveProjectDir}; populated by create / getProject.
 */
interface ProjectIndexEntry {
	projectId: ProjectId
	path: string
}

/**
 * Index of sessionId → (projectId, path). Populated lazily similarly.
 */
interface SessionIndexEntry {
	sessionId: SessionId
	projectId: ProjectId
	path: string
}

export class DiskSessionStore implements SessionStore {
	private readonly rootDir: string
	private readonly projectIndex = new Map<ProjectId, ProjectIndexEntry>()
	private readonly sessionIndex = new Map<SessionId, SessionIndexEntry>()
	private readonly subSessionIndex = new Map<
		SubSessionId,
		{ subSessionId: SubSessionId; sessionId: SessionId; projectId: ProjectId; path: string }
	>()

	constructor(config: DiskSessionStoreConfig) {
		this.rootDir = config.rootDir
	}

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
		const dir = join(this.rootDir, 'projects', project.id)
		await mkdir(dir, { recursive: true })
		await atomicWriteJson(join(dir, 'project.json'), serializeProject(project))
		this.projectIndex.set(project.id, { projectId: project.id, path: dir })
		return project
	}

	async getProject(projectId: ProjectId, tenantId: TenantId): Promise<Project | null> {
		const dir = this.projectDir(projectId)
		const raw = await readJson<PersistedProject>(join(dir, 'project.json'))
		if (!raw) return null
		this.assertTenant(raw.tenantId, tenantId, `project(${projectId})`)
		return deserializeProject(raw)
	}

	// Session CRUD ------------------------------------------------------------

	async createSession(params: CreateSessionParams, tenantId: TenantId): Promise<Session> {
		const project = await this.getProject(params.projectId, tenantId)
		if (!project) {
			throw new Error(`Project ${params.projectId} not found`)
		}
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
		const dir = join(this.projectDir(params.projectId), 'sessions', session.id)
		await mkdir(dir, { recursive: true })
		await atomicWriteJson(join(dir, 'session.json'), serializeSession(session))
		this.sessionIndex.set(session.id, {
			sessionId: session.id,
			projectId: params.projectId,
			path: dir,
		})
		return session
	}

	async getSession(sessionId: SessionId, tenantId: TenantId): Promise<Session | null> {
		const located = await this.locateSession(sessionId)
		if (!located) return null
		const raw = await readJson<PersistedSession>(join(located.path, 'session.json'))
		if (!raw) return null
		this.assertTenant(raw.tenantId, tenantId, `session(${sessionId})`)
		return deserializeSession(raw)
	}

	async listSessions(threadId: ThreadId, tenantId: TenantId): Promise<readonly Session[]> {
		// Walk projects/*/sessions/* and filter on the persisted record. Sessions
		// don't live under a thread-scoped path in the current layout — the
		// denormalized `threadId` on every session.json is the authority. Matches
		// DiskThreadStore.listThreads in scan semantics.
		//
		// Cost: O(all sessions across all projects in the root) per call. The
		// MVP disk store prioritizes simplicity over index freshness, matching
		// `buildLinkageView` / `locateSession` which use the same pattern. A
		// production driver would maintain a threadId → sessionIds secondary
		// index populated on createSession / deleteSession. Acceptable for
		// ThreadManager archive/delete today because those operations are
		// admin-initiated and infrequent.
		const projectsDir = join(this.rootDir, 'projects')
		let projectDirs: string[]
		try {
			projectDirs = await readdir(projectsDir)
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code
			if (code === 'ENOENT') return []
			throw err
		}

		const results: Session[] = []
		for (const rawProject of projectDirs) {
			if (!rawProject.startsWith('prj_')) continue
			const sessionsRoot = join(projectsDir, rawProject, 'sessions')
			let sessionDirs: string[]
			try {
				sessionDirs = await readdir(sessionsRoot)
			} catch {
				continue
			}
			for (const rawSessionId of sessionDirs) {
				if (!rawSessionId.startsWith('ses_')) continue
				const path = join(sessionsRoot, rawSessionId)
				const raw = await readJson<PersistedSession>(join(path, 'session.json'))
				if (!raw) continue
				if (raw.tenantId !== tenantId) continue
				if (raw.threadId !== threadId) continue
				results.push(deserializeSession(raw))
				this.sessionIndex.set(raw.id, {
					sessionId: raw.id,
					projectId: rawProject as ProjectId,
					path,
				})
			}
		}
		results.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
		return results
	}

	async updateSession(session: Session, tenantId: TenantId): Promise<void> {
		const located = await this.locateSession(session.id)
		if (!located) {
			throw new Error(`Session ${session.id} not found`)
		}
		if (session.tenantId !== tenantId) {
			throw new TenantIsolationError({
				requested: tenantId,
				resource: `session(${session.id}) payload`,
			})
		}
		const existing = await readJson<PersistedSession>(join(located.path, 'session.json'))
		if (existing) {
			this.assertTenant(existing.tenantId, tenantId, `session(${session.id})`)
		}
		const updated: Session = { ...session, updatedAt: new Date() }
		await atomicWriteJson(join(located.path, 'session.json'), serializeSession(updated))
	}

	async deleteSession(sessionId: SessionId, tenantId: TenantId): Promise<void> {
		const located = await this.locateSession(sessionId)
		if (!located) return // Idempotent: missing = no-op.
		const existing = await readJson<PersistedSession>(join(located.path, 'session.json'))
		if (!existing) return
		this.assertTenant(existing.tenantId, tenantId, `session(${sessionId})`)

		// Policy: reject if sub-sessions are attached. Callers must delete
		// children first — Convention #5 deny-by-default; no implicit cascade.
		// We check BOTH directions (this session as parent, or as child) to
		// match the in-memory semantics.
		const subsDir = join(located.path, 'subsessions')
		let subEntries: string[] = []
		try {
			subEntries = await readdir(subsDir)
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code
			if (code !== 'ENOENT') throw err
		}
		if (subEntries.some((e) => e.startsWith('sub_'))) {
			throw new Error(
				`Session ${sessionId} has attached sub-sessions; delete them before deleting the session`,
			)
		}

		// Also scan tree for sub-session records that reference this session as
		// `childSessionId`. We need to walk siblings; acceptable cost for the
		// MVP disk store since the broadcast rollback path always pairs a
		// deleteSubSession + deleteSession call on the child (no orphans at
		// steady state).
		const projectsDir = join(this.rootDir, 'projects')
		let projectDirs: string[]
		try {
			projectDirs = await readdir(projectsDir)
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code
			if (code === 'ENOENT') projectDirs = []
			else throw err
		}
		for (const rawProject of projectDirs) {
			if (!rawProject.startsWith('prj_')) continue
			const sessionsRoot = join(projectsDir, rawProject, 'sessions')
			let siblingSessions: string[] = []
			try {
				siblingSessions = await readdir(sessionsRoot)
			} catch {
				continue
			}
			for (const rawSib of siblingSessions) {
				if (!rawSib.startsWith('ses_')) continue
				const sibSubsDir = join(sessionsRoot, rawSib, 'subsessions')
				let sibSubs: string[] = []
				try {
					sibSubs = await readdir(sibSubsDir)
				} catch {
					continue
				}
				for (const rawSub of sibSubs) {
					if (!rawSub.startsWith('sub_')) continue
					const subRaw = await readJson<PersistedSubSession>(
						join(sibSubsDir, rawSub, 'subsession.json'),
					)
					if (!subRaw) continue
					if (subRaw.childSessionId === sessionId || subRaw.parentSessionId === sessionId) {
						throw new Error(
							`Session ${sessionId} has attached sub-sessions; delete them before deleting the session`,
						)
					}
				}
			}
		}

		// Recursive removal — `fs.rm` with `recursive: true` is the atomic
		// primitive for bulk delete. No write-tmp-rename applies here (we're
		// destroying state, not creating it).
		await rm(located.path, { recursive: true, force: true })
		this.sessionIndex.delete(sessionId)
	}

	// SubSession CRUD ---------------------------------------------------------

	async createSubSession(params: CreateSubSessionParams, tenantId: TenantId): Promise<SubSession> {
		const parent = await this.getSession(params.parentSessionId, tenantId)
		if (!parent) throw new Error(`Parent session ${params.parentSessionId} not found`)

		const child = await this.getSession(params.childSessionId, tenantId)
		if (!child) throw new Error(`Child session ${params.childSessionId} not found`)

		const parentLoc = this.sessionIndex.get(params.parentSessionId)
		if (!parentLoc) throw new Error(`Parent session ${params.parentSessionId} missing from index`)

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
		const dir = join(parentLoc.path, 'subsessions', subSession.id)
		await mkdir(dir, { recursive: true })
		await atomicWriteJson(join(dir, 'subsession.json'), serializeSubSession(subSession, tenantId))
		this.subSessionIndex.set(subSession.id, {
			subSessionId: subSession.id,
			sessionId: params.parentSessionId,
			projectId: parentLoc.projectId,
			path: dir,
		})
		return subSession
	}

	async getSubSession(subSessionId: SubSessionId, tenantId: TenantId): Promise<SubSession | null> {
		const located = await this.locateSubSession(subSessionId)
		if (!located) return null
		const raw = await readJson<PersistedSubSession>(join(located.path, 'subsession.json'))
		if (!raw) return null
		this.assertTenant(raw.tenantId, tenantId, `sub-session(${subSessionId})`)
		return deserializeSubSession(raw)
	}

	async updateSubSession(subSession: SubSession, tenantId: TenantId): Promise<void> {
		const located = await this.locateSubSession(subSession.id)
		if (!located) {
			throw new Error(`SubSession ${subSession.id} not found`)
		}
		const existing = await readJson<PersistedSubSession>(join(located.path, 'subsession.json'))
		if (existing) {
			this.assertTenant(existing.tenantId, tenantId, `sub-session(${subSession.id})`)
		}
		const updated: SubSession = { ...subSession, updatedAt: new Date() }
		await atomicWriteJson(
			join(located.path, 'subsession.json'),
			serializeSubSession(updated, tenantId),
		)
	}

	async deleteSubSession(subSessionId: SubSessionId, tenantId: TenantId): Promise<void> {
		const located = await this.locateSubSession(subSessionId)
		if (!located) return // Idempotent: missing = no-op.
		const existing = await readJson<PersistedSubSession>(join(located.path, 'subsession.json'))
		if (!existing) {
			// Record vanished between locate + read — treat as already deleted.
			this.subSessionIndex.delete(subSessionId)
			return
		}
		this.assertTenant(existing.tenantId, tenantId, `sub-session(${subSessionId})`)

		await rm(located.path, { recursive: true, force: true })
		this.subSessionIndex.delete(subSessionId)
	}

	// Messages ----------------------------------------------------------------

	async appendMessage(
		sessionId: SessionId,
		message: Message,
		tenantId: TenantId,
	): Promise<MessageId> {
		const located = await this.locateSession(sessionId)
		if (!located) throw new Error(`Session ${sessionId} not found`)

		const session = await readJson<PersistedSession>(join(located.path, 'session.json'))
		if (!session) throw new Error(`Session ${sessionId} not found on disk`)
		this.assertTenant(session.tenantId, tenantId, `session(${sessionId})`)

		const id = generateMessageId()
		const entry: PersistedMessageLine = {
			id,
			sessionId,
			tenantId,
			message,
			at: new Date().toISOString(),
		}
		await appendFile(join(located.path, 'messages.jsonl'), `${JSON.stringify(entry)}\n`, 'utf-8')
		return id
	}

	async loadMessages(sessionId: SessionId, tenantId: TenantId): Promise<readonly Message[]> {
		const rows = await this.loadSessionMessages(sessionId, tenantId)
		return rows.map((r) => r.message)
	}

	async loadSessionMessages(
		sessionId: SessionId,
		tenantId: TenantId,
	): Promise<readonly SessionMessage[]> {
		const located = await this.locateSession(sessionId)
		if (!located) return []

		const session = await readJson<PersistedSession>(join(located.path, 'session.json'))
		if (!session) return []
		this.assertTenant(session.tenantId, tenantId, `session(${sessionId})`)

		const path = join(located.path, 'messages.jsonl')
		let raw: string
		try {
			raw = await readFile(path, 'utf-8')
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code
			if (code === 'ENOENT') return []
			throw err
		}
		const lines = raw.split('\n').filter((l) => l.length > 0)
		return lines.map((line) => {
			const persisted = JSON.parse(line) as PersistedMessageLine
			return {
				id: persisted.id,
				sessionId: persisted.sessionId,
				tenantId: persisted.tenantId,
				message: persisted.message,
				at: new Date(persisted.at),
			}
		})
	}

	// Linkage -----------------------------------------------------------------

	async getChildren(sessionId: SessionId, tenantId: TenantId): Promise<readonly SubSession[]> {
		const session = await this.getSession(sessionId, tenantId)
		if (!session) return []
		const view = await this.buildLinkageView(tenantId)
		return orderChildren(getChildren(view, sessionId))
	}

	async getAncestry(sessionId: SessionId, tenantId: TenantId): Promise<readonly SessionId[]> {
		const session = await this.getSession(sessionId, tenantId)
		if (!session) return []
		const view = await this.buildLinkageView(tenantId)
		return getAncestry(view, sessionId)
	}

	async drill(sessionId: SessionId, tenantId: TenantId): Promise<SessionView | null> {
		const session = await this.getSession(sessionId, tenantId)
		if (!session) return null
		const view = await this.buildLinkageView(tenantId)
		return {
			session,
			children: orderChildren(getChildren(view, sessionId)),
			ancestry: getAncestry(view, sessionId),
		}
	}

	// Summary (§4.7 / §8.1) ---------------------------------------------------

	/**
	 * Atomic materialize-with-terminal-transition (§8.1). Two write-tmp-renames:
	 *
	 *   1. Persist `summary.json` under the session directory.
	 *   2. Flip `session.json#status` to `'idle'` if it's in a non-terminal
	 *      state (`'active' | 'locked' | 'awaiting_merge'`).
	 *
	 * Each rename is atomic individually. A crash between step 1 and step 2
	 * leaves summary present + session still non-terminal — recovery replays
	 * the flip via {@link SessionSummaryMaterializer.recover}. Idempotent when
	 * the same summary is re-presented (recovery path); rejects a *different*
	 * summary for the same session as {@link SessionAlreadySummarizedError}.
	 */
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

		const located = await this.locateSession(summary.sessionRef)
		if (!located) {
			throw new Error(`Session ${summary.sessionRef} not found`)
		}
		const sessionRaw = await readJson<PersistedSession>(join(located.path, 'session.json'))
		if (!sessionRaw) {
			throw new Error(`Session ${summary.sessionRef} not found on disk`)
		}
		this.assertTenant(sessionRaw.tenantId, tenantId, `session(${summary.sessionRef})`)

		const summaryPath = join(located.path, 'summary.json')
		const existingRaw = await readJson<PersistedSummary>(summaryPath)
		if (existingRaw) {
			this.assertTenant(existingRaw.tenantId, tenantId, `summary(${existingRaw.id})`)
			if (existingRaw.id !== summary.id) {
				throw new SessionAlreadySummarizedError({
					sessionId: summary.sessionRef,
					existingSummaryId: existingRaw.id,
				})
			}
			// Same summary id — recovery replay. No duplicate write; fall through
			// to the status flip so crash-between-writes is recovered.
		} else {
			// Step 1: persist summary.
			await atomicWriteJson(summaryPath, serializeSummary(summary))
		}

		// Step 2: flip session status atomically if still non-terminal.
		if (SUMMARY_TERMINAL_FLIP_STATUSES.has(sessionRaw.status)) {
			const flipped: PersistedSession = {
				...sessionRaw,
				status: 'idle',
				updatedAt: new Date().toISOString(),
			}
			await atomicWriteJson(join(located.path, 'session.json'), flipped)
		}
	}

	async getSummary(sessionId: SessionId, tenantId: TenantId): Promise<SessionSummaryRef | null> {
		const located = await this.locateSession(sessionId)
		if (!located) return null
		const raw = await readJson<PersistedSummary>(join(located.path, 'summary.json'))
		if (!raw) return null
		this.assertTenant(raw.tenantId, tenantId, `summary(${raw.id})`)
		return deserializeSummary(raw)
	}

	// Helpers -----------------------------------------------------------------

	private assertTenant(actual: TenantId, requested: TenantId, resource: string): void {
		if (actual !== requested) {
			throw new TenantIsolationError({ requested, resource })
		}
	}

	private projectDir(projectId: ProjectId): string {
		const cached = this.projectIndex.get(projectId)
		if (cached) return cached.path
		const path = join(this.rootDir, 'projects', projectId)
		this.projectIndex.set(projectId, { projectId, path })
		return path
	}

	private async locateSession(sessionId: SessionId): Promise<SessionIndexEntry | null> {
		const cached = this.sessionIndex.get(sessionId)
		if (cached) return cached

		const projectsDir = join(this.rootDir, 'projects')
		let projectDirs: string[]
		try {
			projectDirs = await readdir(projectsDir)
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code
			if (code === 'ENOENT') return null
			throw err
		}
		for (const rawId of projectDirs) {
			if (!rawId.startsWith('prj_')) continue
			const projectId = rawId as ProjectId
			const sessionsRoot = join(projectsDir, projectId, 'sessions')
			let sessionDirs: string[]
			try {
				sessionDirs = await readdir(sessionsRoot)
			} catch {
				continue
			}
			for (const rawSessionId of sessionDirs) {
				if (!rawSessionId.startsWith('ses_')) continue
				if (rawSessionId === sessionId) {
					const entry: SessionIndexEntry = {
						sessionId,
						projectId,
						path: join(sessionsRoot, rawSessionId),
					}
					this.sessionIndex.set(sessionId, entry)
					return entry
				}
			}
		}
		return null
	}

	private async locateSubSession(subSessionId: SubSessionId): Promise<{
		subSessionId: SubSessionId
		sessionId: SessionId
		projectId: ProjectId
		path: string
	} | null> {
		const cached = this.subSessionIndex.get(subSessionId)
		if (cached) return cached

		const projectsDir = join(this.rootDir, 'projects')
		let projectDirs: string[]
		try {
			projectDirs = await readdir(projectsDir)
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code
			if (code === 'ENOENT') return null
			throw err
		}
		for (const rawProject of projectDirs) {
			if (!rawProject.startsWith('prj_')) continue
			const projectId = rawProject as ProjectId
			const sessionsRoot = join(projectsDir, projectId, 'sessions')
			let sessionDirs: string[]
			try {
				sessionDirs = await readdir(sessionsRoot)
			} catch {
				continue
			}
			for (const rawSession of sessionDirs) {
				if (!rawSession.startsWith('ses_')) continue
				const sessionId = rawSession as SessionId
				const subsDir = join(sessionsRoot, sessionId, 'subsessions')
				let subDirs: string[]
				try {
					subDirs = await readdir(subsDir)
				} catch {
					continue
				}
				for (const rawSub of subDirs) {
					if (rawSub === subSessionId) {
						const entry = {
							subSessionId,
							sessionId,
							projectId,
							path: join(subsDir, rawSub),
						}
						this.subSessionIndex.set(subSessionId, entry)
						return entry
					}
				}
			}
		}
		return null
	}

	private async buildLinkageView(tenantId: TenantId): Promise<LinkageView> {
		// Walk the full projects → sessions → subsessions tree once per call.
		// Acceptable for an MVP disk store; a production impl would cache.
		const allSubs: SubSession[] = []
		const projectsDir = join(this.rootDir, 'projects')
		let projectDirs: string[]
		try {
			projectDirs = await readdir(projectsDir)
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code
			if (code === 'ENOENT') return emptyLinkageView()
			throw err
		}

		for (const rawProject of projectDirs) {
			if (!rawProject.startsWith('prj_')) continue
			const sessionsRoot = join(projectsDir, rawProject, 'sessions')
			let sessionDirs: string[]
			try {
				sessionDirs = await readdir(sessionsRoot)
			} catch {
				continue
			}
			for (const rawSession of sessionDirs) {
				if (!rawSession.startsWith('ses_')) continue
				const subsRoot = join(sessionsRoot, rawSession, 'subsessions')
				let subDirs: string[]
				try {
					subDirs = await readdir(subsRoot)
				} catch {
					continue
				}
				for (const rawSub of subDirs) {
					const raw = await readJson<PersistedSubSession>(join(subsRoot, rawSub, 'subsession.json'))
					if (!raw) continue
					if (raw.tenantId !== tenantId) continue
					allSubs.push(deserializeSubSession(raw))
				}
			}
		}

		return {
			findChildSubSessions: (parentSessionId) =>
				allSubs.filter((s) => s.parentSessionId === parentSessionId),
			findParentSubSession: (childSessionId) =>
				allSubs.find((s) => s.childSessionId === childSessionId) ?? null,
		}
	}
}

function emptyLinkageView(): LinkageView {
	return {
		findChildSubSessions: () => [],
		findParentSubSession: () => null,
	}
}

// Serialization helpers -----------------------------------------------------

function serializeProject(p: Project): PersistedProject {
	return {
		id: p.id,
		tenantId: p.tenantId,
		name: p.name,
		config: p.config,
		createdAt: p.createdAt.toISOString(),
		updatedAt: p.updatedAt.toISOString(),
	}
}

function deserializeProject(p: PersistedProject): Project {
	return {
		id: p.id,
		tenantId: p.tenantId,
		name: p.name,
		config: p.config,
		createdAt: new Date(p.createdAt),
		updatedAt: new Date(p.updatedAt),
	}
}

function serializeSession(s: Session): PersistedSession {
	return {
		id: s.id,
		threadId: s.threadId,
		projectId: s.projectId,
		tenantId: s.tenantId,
		status: s.status,
		currentActor: s.currentActor,
		previousActors: s.previousActors,
		workspaceId: s.workspaceId,
		ownerVersion: s.ownerVersion,
		createdAt: s.createdAt.toISOString(),
		updatedAt: s.updatedAt.toISOString(),
	}
}

function deserializeSession(s: PersistedSession): Session {
	return {
		id: s.id,
		threadId: s.threadId,
		projectId: s.projectId,
		tenantId: s.tenantId,
		status: s.status,
		currentActor: s.currentActor,
		previousActors: s.previousActors,
		workspaceId: s.workspaceId,
		ownerVersion: s.ownerVersion,
		createdAt: new Date(s.createdAt),
		updatedAt: new Date(s.updatedAt),
	}
}

function serializeSubSession(s: SubSession, tenantId: TenantId): PersistedSubSession {
	return {
		id: s.id,
		parentSessionId: s.parentSessionId,
		childSessionId: s.childSessionId,
		tenantId,
		kind: s.kind,
		status: s.status,
		spawnedBy: s.spawnedBy,
		spawnedAt: s.spawnedAt.toISOString(),
		failureMode: s.failureMode,
		completionMode: s.completionMode,
		workspaceId: s.workspaceId,
		...(s.broadcastGroupId !== undefined && { broadcastGroupId: s.broadcastGroupId }),
		...(s.summaryRef !== undefined && { summaryRef: s.summaryRef }),
		...(s.archiveRef !== undefined && { archiveRef: s.archiveRef }),
		...(s.archivedAt !== undefined && { archivedAt: s.archivedAt.toISOString() }),
		updatedAt: s.updatedAt.toISOString(),
	}
}

function deserializeSubSession(s: PersistedSubSession): SubSession {
	return {
		id: s.id,
		parentSessionId: s.parentSessionId,
		childSessionId: s.childSessionId,
		kind: s.kind,
		status: s.status,
		spawnedBy: s.spawnedBy,
		spawnedAt: new Date(s.spawnedAt),
		failureMode: s.failureMode,
		completionMode: s.completionMode,
		workspaceId: s.workspaceId,
		...(s.broadcastGroupId !== undefined && { broadcastGroupId: s.broadcastGroupId }),
		...(s.summaryRef !== undefined && { summaryRef: s.summaryRef }),
		...(s.archiveRef !== undefined && { archiveRef: s.archiveRef }),
		...(s.archivedAt !== undefined && { archivedAt: new Date(s.archivedAt) }),
		updatedAt: new Date(s.updatedAt),
	}
}

function serializeSummary(s: SessionSummaryRef): PersistedSummary {
	return {
		id: s.id,
		sessionRef: s.sessionRef,
		tenantId: s.tenantId,
		outcome: s.outcome,
		deliverables: s.deliverables,
		agentSummary: s.agentSummary,
		keyDecisions: s.keyDecisions.map((k) => ({
			at: k.at.toISOString(),
			summary: k.summary,
		})),
		at: s.at.toISOString(),
		materializedBy: 'kernel',
	}
}

function deserializeSummary(s: PersistedSummary): SessionSummaryRef {
	const decisions: SessionSummaryKeyDecision[] = s.keyDecisions.map((k) => ({
		at: new Date(k.at),
		summary: k.summary,
	}))
	return {
		id: s.id,
		sessionRef: s.sessionRef,
		tenantId: s.tenantId,
		outcome: s.outcome,
		deliverables: s.deliverables,
		agentSummary: s.agentSummary,
		keyDecisions: decisions,
		at: new Date(s.at),
		materializedBy: 'kernel',
	}
}

// FS helpers -----------------------------------------------------------------

async function readJson<T>(path: string): Promise<T | null> {
	try {
		const raw = await readFile(path, 'utf-8')
		return JSON.parse(raw) as T
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code
		if (code === 'ENOENT') return null
		throw err
	}
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
	const tempPath = `${filePath}.tmp`
	try {
		await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf-8')
		await rename(tempPath, filePath)
	} catch (err) {
		await unlink(tempPath).catch(() => undefined)
		throw err
	}
}

// Note: messages are append-only `messages.jsonl` (not write-tmp-rename).
// Append is the write-safety primitive for log-structured files; each
// line is a whole record. This matches pattern doc §13.4 persistence
// (`messages.json[l]` as append-only event log).

export type { SessionMessage } from './messages.js'
