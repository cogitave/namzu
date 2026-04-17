/**
 * Boot-time filesystem re-layout — `.namzu/threads/{thd_X}/` →
 * `.namzu/projects/{prj_legacy_<X>}/sessions/ses_legacy_default/runs/...`.
 *
 * Trigger: first {@link RunContextFactory.build} call per process. The
 * factory invokes {@link DefaultFilesystemMigrator.migrate} before resolving
 * any path so legacy runs are never orphaned by the new layout.
 *
 * See session-hierarchy.md §13.4.1 for the detection / trigger / atomicity
 * contract. Concurrency model:
 *
 *   1. Main marker present → short-circuit `already_migrated`. Idempotent.
 *   2. Legacy `.namzu/threads/` absent → write the main marker and return
 *      `noop_no_legacy`. This plants the marker on fresh installs so the
 *      `threads/` detection branch is only ever entered once.
 *   3. Legacy layout detected → acquire the `.tmp` lock via `wx`; on
 *      EEXIST another boot is mid-migration. The loser waits 100ms and
 *      re-checks the main marker — cooperating, not competing. Roadmap
 *      Risk #4 mitigation.
 *   4. Per-legacy-thread: rename the whole `runs/` subtree in a single
 *      `fs.rename` call (cross-OS atomic on the same filesystem; different
 *      filesystems fall back to copy-then-unlink via Node's default — a
 *      known limitation documented below).
 *   5. Synthesize `project.json` + `session.json` via write-tmp-rename
 *      (Convention #8) so partial crashes leave no half-serialised state.
 *   6. Write main marker last — presence of the marker is the canonical
 *      "migration done" signal.
 *
 * Known limitations:
 *  - Cross-filesystem moves: Node's `fs.rename` rejects with `EXDEV` when
 *    source and target live on different filesystems. This migrator does
 *    NOT fall back to copy-then-unlink; the error surfaces as
 *    {@link FilesystemMigrationError} with op `'rename_runs'`. Consumers
 *    running `.namzu/threads` and `.namzu/projects` on different mounts
 *    must migrate manually (documented INTERP flag).
 *  - `UNKNOWN_TENANT_ID`: legacy threads have no tenant denormalisation on
 *    disk. The synthesised project.json carries the sentinel so consumers
 *    know these are legacy-rehomed and can either tag-then-retain or
 *    reject until a real tenant is assigned (policy is consumer-owned).
 */

import { mkdir, readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TenantId } from '../../types/ids/index.js'
import { UNKNOWN_TENANT_ID } from '../../types/ids/index.js'
import type { ProjectId, SessionId } from '../../types/session/ids.js'
import { FilesystemMigrationError } from './errors.js'
import { acquireMigrationLock, readMarker, releaseMigrationLock, writeMarker } from './marker.js'

/**
 * Sentinel SessionId used for legacy pre-0.2.0 runs that pre-date the
 * Session entity. Every migrated thread collapses into this single session
 * so consumers can still address the runs through the new layout.
 */
export const LEGACY_DEFAULT_SESSION_ID = 'ses_legacy_default' as SessionId

/** Prefix for projects synthesised from legacy `thd_*` folders. */
export const LEGACY_DEFAULT_PROJECT_PREFIX = 'prj_legacy_'

/** Marker version string persisted at `.migration/v0.2.0`. */
export const MIGRATION_VERSION = '0.2.0'

/** Marker file path relative to rootDir. */
export const MARKER_REL_PATH = join('.migration', 'v0.2.0')

/** In-flight lock file path relative to rootDir. */
export const LOCK_REL_PATH = join('.migration', 'v0.2.0.tmp')

/** Delay before the loser re-checks the main marker on lock contention. */
const LOCK_WAIT_MS = 100

/**
 * Result of a migration attempt. `kind` discriminates the three outcomes;
 * `migratedThreads` is only non-empty for `kind: 'migrated'`. Sinks and
 * callers can switch on `kind` without string parsing.
 */
export interface FilesystemMigrationResult {
	kind: 'migrated' | 'already_migrated' | 'noop_no_legacy'
	migratedThreads: readonly { legacyThreadId: string; newProjectId: ProjectId }[]
	markerPath: string
	at: Date
}

/** Event emitted on successful migration (`kind === 'migrated'` only). */
export interface FilesystemMigrationEvent {
	type: 'filesystem.migrated'
	result: FilesystemMigrationResult
}

/** Sink contract — one `emit` method. */
export interface FilesystemMigrationSink {
	emit(event: FilesystemMigrationEvent): void
}

export const NOOP_FILESYSTEM_MIGRATION_SINK: FilesystemMigrationSink = {
	emit() {},
}

/** Interface so consumers can inject a stub migrator in tests. */
export interface FilesystemMigrator {
	migrate(rootDir: string): Promise<FilesystemMigrationResult>
}

/**
 * Persisted synthetic `project.json` shape. Matches
 * `store/session/disk.ts:PersistedProject` plus a `_legacy: true` flag so
 * readers can distinguish auto-synthesised records from real ones.
 */
interface SyntheticProject {
	id: ProjectId
	tenantId: TenantId
	name: string
	config: {
		maxDelegationDepth: number
		maxDelegationWidth: number
		maxInterventionDepth: number
	}
	createdAt: string
	updatedAt: string
	_legacy: true
}

/**
 * Persisted synthetic `session.json` shape. Matches
 * `store/session/disk.ts:PersistedSession` minimally. Status is `idle` so
 * any read path that drills into these sessions does not mistake them for
 * active work. `_legacy: true` flags them as auto-synthesised.
 */
interface SyntheticSession {
	id: SessionId
	projectId: ProjectId
	tenantId: TenantId
	status: 'idle'
	currentActor: null
	previousActors: readonly []
	workspaceId: null
	ownerVersion: 0
	createdAt: string
	updatedAt: string
	_legacy: true
}

/**
 * Default implementation. Migration is driven by the contract documented in
 * the module header — readers should trace concerns to this comment rather
 * than re-deriving from code.
 */
export class DefaultFilesystemMigrator implements FilesystemMigrator {
	constructor(private readonly sink: FilesystemMigrationSink = NOOP_FILESYSTEM_MIGRATION_SINK) {}

	async migrate(rootDir: string): Promise<FilesystemMigrationResult> {
		const markerPath = join(rootDir, MARKER_REL_PATH)
		const lockPath = join(rootDir, LOCK_REL_PATH)
		const threadsDir = join(rootDir, 'threads')
		const projectsDir = join(rootDir, 'projects')

		// Step 1: completed-marker short-circuit (cheapest idempotency check).
		const existing = await readMarker(markerPath)
		if (existing) {
			return {
				kind: 'already_migrated',
				migratedThreads: [],
				markerPath,
				at: existing.at,
			}
		}

		// Step 2: legacy absent → no-op. Plant the marker so subsequent boots
		// do not re-enter this branch. Fresh installs fall through here.
		const threadsExists = await directoryExists(threadsDir)
		if (!threadsExists) {
			const at = new Date()
			try {
				await writeMarker(markerPath, {
					version: MIGRATION_VERSION,
					at,
					migratedThreads: [],
				})
			} catch (cause) {
				throw new FilesystemMigrationError({
					op: 'write_marker',
					path: markerPath,
					cause,
				})
			}
			return {
				kind: 'noop_no_legacy',
				migratedThreads: [],
				markerPath,
				at,
			}
		}

		// Step 3: cooperate on the tmp lock.
		try {
			await acquireMigrationLock(lockPath)
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code
			if (code === 'EEXIST') {
				// Another boot is mid-migration — wait and re-read the main marker.
				await sleep(LOCK_WAIT_MS)
				const follow = await readMarker(markerPath)
				if (follow) {
					return {
						kind: 'already_migrated',
						migratedThreads: [],
						markerPath,
						at: follow.at,
					}
				}
				// Main marker still absent — the winning boot is still going OR
				// crashed. We re-throw so the caller sees a contention surface
				// rather than silently assuming success.
				throw new FilesystemMigrationError({
					op: 'acquire_lock',
					path: lockPath,
					cause: err,
				})
			}
			throw new FilesystemMigrationError({
				op: 'acquire_lock',
				path: lockPath,
				cause: err,
			})
		}

		try {
			// Step 4a: enumerate legacy thread dirs.
			let entries: string[]
			try {
				entries = await readdir(threadsDir)
			} catch (cause) {
				throw new FilesystemMigrationError({
					op: 'enumerate_threads',
					path: threadsDir,
					cause,
				})
			}

			const migrated: { legacyThreadId: string; newProjectId: ProjectId }[] = []
			const now = new Date()

			for (const entry of entries) {
				// Accept only `thd_*` (and tolerate `prj_*` legacy in case of
				// rerun after a partial-crash-with-renamed-but-no-marker).
				if (!entry.startsWith('thd_')) continue

				const legacyThreadId = entry
				const suffix = legacyThreadId.slice('thd_'.length)
				const newProjectId = `${LEGACY_DEFAULT_PROJECT_PREFIX}${suffix}` as ProjectId

				const legacyRunsDir = join(threadsDir, legacyThreadId, 'runs')
				const newProjectDir = join(projectsDir, newProjectId)
				const newSessionDir = join(newProjectDir, 'sessions', LEGACY_DEFAULT_SESSION_ID)
				const newRunsDir = join(newSessionDir, 'runs')

				// Ensure parent path exists for the atomic rename of `runs/`.
				try {
					await mkdir(newSessionDir, { recursive: true })
				} catch (cause) {
					throw new FilesystemMigrationError({
						op: 'mkdir_session',
						path: newSessionDir,
						cause,
					})
				}

				// Move the whole `runs/` subtree in a single rename — atomic on
				// same-filesystem, EXDEV on cross-mount (documented limitation).
				const legacyRunsExists = await directoryExists(legacyRunsDir)
				if (legacyRunsExists) {
					try {
						await rename(legacyRunsDir, newRunsDir)
					} catch (cause) {
						throw new FilesystemMigrationError({
							op: 'rename_runs',
							path: legacyRunsDir,
							cause,
						})
					}
				}

				// Step 4b: synthesize project.json via write-tmp-rename.
				const projectJson: SyntheticProject = {
					id: newProjectId,
					tenantId: UNKNOWN_TENANT_ID,
					name: `legacy ${legacyThreadId}`,
					config: {
						maxDelegationDepth: 4,
						maxDelegationWidth: 8,
						maxInterventionDepth: 10,
					},
					createdAt: now.toISOString(),
					updatedAt: now.toISOString(),
					_legacy: true,
				}
				const projectJsonPath = join(newProjectDir, 'project.json')
				try {
					await atomicWriteJson(projectJsonPath, projectJson)
				} catch (cause) {
					throw new FilesystemMigrationError({
						op: 'write_project_json',
						path: projectJsonPath,
						cause,
					})
				}

				// Step 4c: synthesize session.json for the legacy-default session.
				const sessionJson: SyntheticSession = {
					id: LEGACY_DEFAULT_SESSION_ID,
					projectId: newProjectId,
					tenantId: UNKNOWN_TENANT_ID,
					status: 'idle',
					currentActor: null,
					previousActors: [],
					workspaceId: null,
					ownerVersion: 0,
					createdAt: now.toISOString(),
					updatedAt: now.toISOString(),
					_legacy: true,
				}
				const sessionJsonPath = join(newSessionDir, 'session.json')
				try {
					await atomicWriteJson(sessionJsonPath, sessionJson)
				} catch (cause) {
					throw new FilesystemMigrationError({
						op: 'write_session_json',
						path: sessionJsonPath,
						cause,
					})
				}

				migrated.push({ legacyThreadId, newProjectId })
			}

			// Step 5: write the completion marker last. Presence = done.
			try {
				await writeMarker(markerPath, {
					version: MIGRATION_VERSION,
					at: now,
					migratedThreads: migrated,
				})
			} catch (cause) {
				throw new FilesystemMigrationError({
					op: 'write_marker',
					path: markerPath,
					cause,
				})
			}

			const result: FilesystemMigrationResult = {
				kind: 'migrated',
				migratedThreads: migrated,
				markerPath,
				at: now,
			}

			// Step 6: emit event.
			this.sink.emit({ type: 'filesystem.migrated', result })

			return result
		} finally {
			// Always release the lock — even on failure, a crashed run with the
			// main marker absent will retry on the next boot; the stale `.tmp`
			// would otherwise wedge that retry.
			await releaseMigrationLock(lockPath).catch(() => undefined)
		}
	}
}

/**
 * Shared atomic-write helper. Mirrors `store/session/disk.ts:atomicWriteJson`
 * — intentionally duplicated so `session/migration/` has no inbound
 * dependency on the store layer (Convention #4 dependency direction).
 */
async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
	const { writeFile, rename: renameFile, unlink } = await import('node:fs/promises')
	const tmp = `${filePath}.tmp`
	try {
		await writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8')
		await renameFile(tmp, filePath)
	} catch (err) {
		await unlink(tmp).catch(() => undefined)
		throw err
	}
}

async function directoryExists(path: string): Promise<boolean> {
	try {
		const s = await stat(path)
		return s.isDirectory()
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code
		if (code === 'ENOENT') return false
		throw err
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
