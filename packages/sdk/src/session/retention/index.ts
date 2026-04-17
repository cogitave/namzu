// Sub-barrel for the retention/archival module (Convention #4).
// Concrete types + manager live in sibling files.

export type { ArchiveBackendRef } from './archive-backend-ref.js'
export type { RetentionPolicy } from './policy.js'
export { RETENTION_POLICY_DISABLED } from './policy.js'
export type { ArchiveBackend, ArchiveInput, ArchiveOutput, SubSessionTombstone } from './backend.js'
export {
	ArchivalManager,
	ArchiveNotConfiguredError,
	SubSessionNotArchivableError,
	SubSessionNotArchivedError,
} from './archive.js'
export type { ArchivalManagerDeps, WorkspaceResolver } from './archive.js'
export { ArchiveNotFoundError, DiskArchiveBackend } from './disk-backend.js'
export type { DiskArchiveBackendConfig } from './disk-backend.js'
