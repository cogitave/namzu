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

import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
	updatedAt: string
}

interface PersistedMessageLine {
	id: MessageId
	sessionId: SessionId
	tenantId: TenantId
	message: Message
	at: string
}

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
		return lines.map((line) => (JSON.parse(line) as PersistedMessageLine).message)
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
		updatedAt: new Date(s.updatedAt),
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
