/**
 * Migration marker file I/O — ensures the boot-time v0.2.0 re-layout is
 * idempotent and race-safe.
 *
 * Layout:
 *   {rootDir}/.migration/v0.2.0       — completion marker (JSON body)
 *   {rootDir}/.migration/v0.2.0.tmp   — in-flight lock (O_EXCL / `wx` flag)
 *
 * Atomicity contract (Convention #8):
 *  - `writeMarker` goes through write-tmp-rename so readers never see a
 *    partially serialized body.
 *  - `acquireMigrationLock` uses the `wx` flag (O_CREAT | O_EXCL) so
 *    concurrent boots detect each other rather than overwriting. Loser
 *    cooperates (see filesystem.ts — waits and re-checks the main marker).
 *  - `readMarker` tolerates missing / corrupt files: missing → null,
 *    corrupt JSON → null (not throw). The migrator treats either as "run
 *    again"; a corrupt marker is safer to retry than to honor as valid.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ProjectId } from '../../types/session/ids.js'

/**
 * Marker payload. `migratedThreads` preserves the legacy → new mapping so
 * later tooling (e.g. `namzu sdk migrate-ids`) can cross-reference.
 */
export interface MigrationMarker {
	version: string
	at: Date
	migratedThreads: readonly { legacyThreadId: string; newProjectId: ProjectId }[]
}

interface PersistedMarker {
	version: string
	at: string
	migratedThreads: readonly { legacyThreadId: string; newProjectId: string }[]
}

/**
 * Read a marker file. Returns `null` when the file is absent OR when the
 * contents fail JSON.parse — corruption is treated as "migration did not
 * complete cleanly", so the caller re-runs rather than honoring stale data.
 */
export async function readMarker(path: string): Promise<MigrationMarker | null> {
	let raw: string
	try {
		raw = await readFile(path, 'utf-8')
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code
		if (code === 'ENOENT') return null
		throw err
	}

	let parsed: PersistedMarker
	try {
		parsed = JSON.parse(raw) as PersistedMarker
	} catch {
		return null
	}

	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		typeof parsed.version !== 'string' ||
		typeof parsed.at !== 'string' ||
		!Array.isArray(parsed.migratedThreads)
	) {
		return null
	}

	return {
		version: parsed.version,
		at: new Date(parsed.at),
		migratedThreads: parsed.migratedThreads.map((m) => ({
			legacyThreadId: m.legacyThreadId,
			newProjectId: m.newProjectId as ProjectId,
		})),
	}
}

/**
 * Write a marker atomically via write-tmp-rename. Parent directory is
 * created on demand so callers do not have to mkdir separately.
 */
export async function writeMarker(path: string, marker: MigrationMarker): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	const serialized: PersistedMarker = {
		version: marker.version,
		at: marker.at.toISOString(),
		migratedThreads: marker.migratedThreads.map((m) => ({
			legacyThreadId: m.legacyThreadId,
			newProjectId: m.newProjectId as string,
		})),
	}
	const tmp = `${path}.write.tmp`
	try {
		await writeFile(tmp, JSON.stringify(serialized, null, 2), 'utf-8')
		await rename(tmp, path)
	} catch (err) {
		await unlink(tmp).catch(() => undefined)
		throw err
	}
}

/**
 * Acquire an exclusive lock by creating `tmpPath` with the `wx` flag.
 * EEXIST means another process is mid-migration — callers must treat that
 * as "wait and re-check the main marker" rather than overwriting.
 *
 * Returns on success; throws the raw `NodeJS.ErrnoException` on EEXIST or
 * any other FS failure so the caller can branch on `code`.
 */
export async function acquireMigrationLock(tmpPath: string): Promise<void> {
	await mkdir(dirname(tmpPath), { recursive: true })
	await writeFile(tmpPath, JSON.stringify({ at: new Date().toISOString() }), { flag: 'wx' })
}

/**
 * Release the lock. Missing file is tolerated — lock release is idempotent
 * by design so crashed mid-migrations do not wedge subsequent boots.
 */
export async function releaseMigrationLock(tmpPath: string): Promise<void> {
	try {
		await unlink(tmpPath)
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code
		if (code === 'ENOENT') return
		throw err
	}
}
