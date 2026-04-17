/**
 * Typed errors for the migration module.
 *
 * See session-hierarchy.md §13.4.1. Structured `details` payload lets
 * consumers route failures without string parsing (Convention #5: fail
 * fast, surface cause, no silent swallowing).
 */

/**
 * Raised when any filesystem step during the boot-time v0.2.0 re-layout
 * fails (enumerate, rename, synthesize project.json, write marker).
 * `op` is a short stable tag so consumers can dashboard on failure mode;
 * `cause` carries the underlying `Error` for stack preservation.
 */
export class FilesystemMigrationError extends Error {
	readonly details: { op: string; path: string; cause?: unknown }

	constructor(details: { op: string; path: string; cause?: unknown }) {
		super(`Filesystem migration failed at ${details.op} on ${details.path}`)
		this.name = 'FilesystemMigrationError'
		this.details = details
	}
}
