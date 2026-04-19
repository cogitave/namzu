/**
 * DiskThreadStore — filesystem-backed implementation of {@link ThreadStore}.
 *
 * Every mutation is write-tmp-rename (Convention #8). Layout uses the Phase 2
 * intermediate shape:
 *
 *   {rootDir}/projects/{projectId}/threads/{threadId}/
 *     thread.json
 *
 * Sessions stay under `projects/{projectId}/sessions/{sessionId}/...` rather
 * than nesting under `threads/{threadId}/` — the denormalized `threadId` on
 * each session record (Phase 2.4 decision) makes thread-scoped queries
 * addressable without path-level nesting, and keeps Project-scoped consumers
 * (handoff, retention, archival) a single-directory scan. Phase 6 collapses
 * `projects/{projectId}/` to `.namzu/` as part of `namzu init` folder binding.
 *
 * Tenant scoping is enforced through the JSON payload (`tenantId` field on
 * every record), not the path — cross-tenant reads reject with
 * {@link TenantIsolationError} (Convention #17).
 */

import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StaleThreadError, TenantIsolationError } from '../../session/errors.js'
import type { Thread, ThreadStatus } from '../../session/hierarchy/thread.js'
import type { TenantId } from '../../types/ids/index.js'
import type { ProjectId, ThreadId } from '../../types/session/ids.js'
import type { CreateThreadParams, ThreadStore } from '../../types/thread/store.js'
import { generateThreadId } from '../../utils/id.js'

/** Config for {@link DiskThreadStore}. `rootDir` is absolute. */
export interface DiskThreadStoreConfig {
	rootDir: string
}

interface PersistedThread {
	id: ThreadId
	projectId: ProjectId
	tenantId: TenantId
	title: string
	status: ThreadStatus
	ownerVersion: number
	createdAt: string
	updatedAt: string
}

/** Index of threadId → (projectId, path). Lazy; populated on create / lookup. */
interface ThreadIndexEntry {
	threadId: ThreadId
	projectId: ProjectId
	path: string
}

export class DiskThreadStore implements ThreadStore {
	private readonly rootDir: string
	private readonly threadIndex = new Map<ThreadId, ThreadIndexEntry>()

	constructor(config: DiskThreadStoreConfig) {
		this.rootDir = config.rootDir
	}

	async createThread(params: CreateThreadParams, tenantId: TenantId): Promise<Thread> {
		const now = new Date()
		const thread: Thread = {
			id: generateThreadId(),
			projectId: params.projectId,
			tenantId,
			title: params.title,
			status: 'open',
			ownerVersion: 0,
			createdAt: now,
			updatedAt: now,
		}
		const dir = join(this.rootDir, 'projects', params.projectId, 'threads', thread.id)
		await mkdir(dir, { recursive: true })
		await atomicWriteJson(join(dir, 'thread.json'), serializeThread(thread))
		this.threadIndex.set(thread.id, {
			threadId: thread.id,
			projectId: params.projectId,
			path: dir,
		})
		return thread
	}

	async getThread(threadId: ThreadId, tenantId: TenantId): Promise<Thread | null> {
		const located = await this.locateThread(threadId)
		if (!located) return null
		const raw = await readJson<PersistedThread>(join(located.path, 'thread.json'))
		if (!raw) return null
		this.assertTenant(raw.tenantId, tenantId, `thread(${threadId})`)
		return deserializeThread(raw)
	}

	async updateThread(thread: Thread, tenantId: TenantId): Promise<void> {
		if (thread.tenantId !== tenantId) {
			throw new TenantIsolationError({
				requested: tenantId,
				resource: `thread(${thread.id}) payload`,
			})
		}
		const located = await this.locateThread(thread.id)
		if (!located) {
			throw new Error(`Thread ${thread.id} not found`)
		}
		const existing = await readJson<PersistedThread>(join(located.path, 'thread.json'))
		if (!existing) {
			throw new Error(`Thread ${thread.id} not found`)
		}
		this.assertTenant(existing.tenantId, tenantId, `thread(${thread.id})`)

		// CAS on ownerVersion. On mismatch, caller must re-read + re-apply +
		// retry. No silent overwrite (Convention #0).
		if (thread.ownerVersion !== existing.ownerVersion) {
			throw new StaleThreadError({
				threadId: thread.id,
				expectedVersion: thread.ownerVersion,
				actualVersion: existing.ownerVersion,
			})
		}

		const updated: Thread = {
			...thread,
			ownerVersion: existing.ownerVersion + 1,
			updatedAt: new Date(),
		}
		await atomicWriteJson(join(located.path, 'thread.json'), serializeThread(updated))
	}

	async deleteThread(threadId: ThreadId, tenantId: TenantId): Promise<void> {
		const located = await this.locateThread(threadId)
		if (!located) return // Idempotent: missing = no-op.
		const existing = await readJson<PersistedThread>(join(located.path, 'thread.json'))
		if (!existing) return
		this.assertTenant(existing.tenantId, tenantId, `thread(${threadId})`)

		// The store does NOT enforce "no attached sessions" here — that is a
		// cross-store precondition owned by ThreadManager. This keeps the
		// boundary clean; ThreadStore has no awareness of SessionStore layout.
		await rm(located.path, { recursive: true, force: true })
		this.threadIndex.delete(threadId)
	}

	async listThreads(projectId: ProjectId, tenantId: TenantId): Promise<readonly Thread[]> {
		const threadsDir = join(this.rootDir, 'projects', projectId, 'threads')
		let entries: string[]
		try {
			entries = await readdir(threadsDir)
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code
			if (code === 'ENOENT') return []
			throw err
		}

		const results: Thread[] = []
		for (const entry of entries) {
			if (!entry.startsWith('thd_')) continue
			const path = join(threadsDir, entry)
			const raw = await readJson<PersistedThread>(join(path, 'thread.json'))
			if (!raw) continue
			// Cross-tenant records in the same directory are skipped silently —
			// the listing is scoped to the caller's tenant. Mismatch is not an
			// isolation violation because the caller never requested the record.
			if (raw.tenantId !== tenantId) continue
			results.push(deserializeThread(raw))
			this.threadIndex.set(raw.id, { threadId: raw.id, projectId, path })
		}
		results.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
		return results
	}

	private async locateThread(threadId: ThreadId): Promise<ThreadIndexEntry | null> {
		const cached = this.threadIndex.get(threadId)
		if (cached) return cached

		// Walk projects/* looking for the thread dir. Cost is bounded by number
		// of projects (usually 1) × number of threads per project.
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
			const threadPath = join(projectsDir, rawProject, 'threads', threadId)
			const raw = await readJson<PersistedThread>(join(threadPath, 'thread.json'))
			if (raw?.id === threadId) {
				const entry: ThreadIndexEntry = {
					threadId,
					projectId: rawProject as ProjectId,
					path: threadPath,
				}
				this.threadIndex.set(threadId, entry)
				return entry
			}
		}
		return null
	}

	private assertTenant(owning: TenantId, requested: TenantId, resource: string): void {
		if (owning !== requested) {
			throw new TenantIsolationError({ requested, resource })
		}
	}
}

// Serialization -----------------------------------------------------------

function serializeThread(thread: Thread): PersistedThread {
	return {
		id: thread.id,
		projectId: thread.projectId,
		tenantId: thread.tenantId,
		title: thread.title,
		status: thread.status,
		ownerVersion: thread.ownerVersion,
		createdAt: thread.createdAt.toISOString(),
		updatedAt: thread.updatedAt.toISOString(),
	}
}

function deserializeThread(raw: PersistedThread): Thread {
	return {
		id: raw.id,
		projectId: raw.projectId,
		tenantId: raw.tenantId,
		title: raw.title,
		status: raw.status,
		ownerVersion: raw.ownerVersion,
		createdAt: new Date(raw.createdAt),
		updatedAt: new Date(raw.updatedAt),
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
