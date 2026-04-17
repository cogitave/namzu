// Sub-barrel for the migration module (Convention #4).
// Public surface for boot-time FS re-layout + ID-prefix read-accept.
// See session-hierarchy.md §13.3.1 (ID prefix) + §13.4.1 (filesystem).

export {
	acceptLegacyThreadId,
	rejectLegacyPrefix,
	NOOP_MIGRATION_WARNING_SINK,
	StalePrefixError,
	WINDOW_OPEN,
} from './id-prefix.js'
export type { MigrationWarning, MigrationWarningSink } from './id-prefix.js'

export {
	DefaultFilesystemMigrator,
	NOOP_FILESYSTEM_MIGRATION_SINK,
	LEGACY_DEFAULT_SESSION_ID,
	LEGACY_DEFAULT_PROJECT_PREFIX,
	MIGRATION_VERSION,
	MARKER_REL_PATH,
	LOCK_REL_PATH,
} from './filesystem.js'
export type {
	FilesystemMigrator,
	FilesystemMigrationResult,
	FilesystemMigrationEvent,
	FilesystemMigrationSink,
} from './filesystem.js'

export {
	readMarker,
	writeMarker,
	acquireMigrationLock,
	releaseMigrationLock,
} from './marker.js'
export type { MigrationMarker } from './marker.js'

export { FilesystemMigrationError } from './errors.js'
